import "server-only";
import { z } from "zod";
import type { Prisma, SalesforceConnection } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decryptJson, encryptJson } from "@/lib/crypto";
import { maskSecret } from "@/lib/mask";
import { env } from "@/lib/env";
import { badRequest, notFound } from "@/lib/errors";
import { SfmcClient, clearSfmcTokenCache, normalizeBaseUri, assertSfmcHost } from "@/lib/salesforce/client";
import { SfmcError, isSfmcError } from "@/lib/salesforce/errors";
import { CAPABILITY_PROBES, REST_OBJECTS, SOAP_OBJECTS } from "@/lib/salesforce/objects";
import { READ_SCOPES_RECOMMENDED } from "@/lib/salesforce/readonly";
import { createSimulatedFetch, SIM_HOST, type SimOptions } from "@/lib/salesforce/simulator";
import { DEFAULT_SOURCE_UTC_OFFSET, isValidOffset, toSfmcDateValue } from "@/lib/salesforce/dates";
import { prop } from "@/lib/salesforce/soap";
import { archiveAudit, type ArchiveActor } from "./audit";

// ─── Settings ─────────────────────────────────────────────────────────

const RetentionSource = z.object({
  days: z.coerce.number().int().min(1).max(36500).nullable().default(null),
  basis: z.string().max(500).default(""),
  confirmed: z.boolean().default(false),
});

export const ConnectionSettingsSchema = z.object({
  maxConcurrent: z.coerce.number().int().min(1).max(8).default(4),
  minIntervalMs: z.coerce.number().int().min(0).max(10_000).default(250),
  maxRetries: z.coerce.number().int().min(1).max(10).default(5),
  pagesPerStep: z.coerce.number().int().min(1).max(200).default(10),
  /** Datasets extracted concurrently within one backup (each still paced by maxConcurrent). */
  parallelDatasets: z.coerce.number().int().min(1).max(8).default(4),
  sourceUtcOffset: z.string().refine(isValidOffset, "Use ±HH:MM").default(DEFAULT_SOURCE_UTC_OFFSET),
  sourceUtcOffsetConfirmed: z.boolean().default(false),
  /**
   * Retention windows per tracking source. Defaults reflect publicly reported policy and are
   * marked UNCONFIRMED until an administrator verifies them with Salesforce for this account.
   */
  retention: z
    .object({
      soapTracking: RetentionSource.default({
        days: 730,
        basis: "Marketing Cloud Engagement data retention policy effective 16 Jun 2025 (subscriber engagement tracking, Email Studio tracking/reports) — as reported by secondary sources; confirm with Salesforce for this account.",
        confirmed: false,
      }),
      dataViews: RetentionSource.default({ days: 180, basis: "System data views (_Sent, _Open, …) commonly limited to ~6 months — not used by the read-only path.", confirmed: false }),
      individualEmailResults: RetentionSource.default({ days: 90, basis: "Individual Email Results (IER) — as reported; not used by the read-only path.", confirmed: false }),
    })
    .prefault({}),
  simulator: z.object({ pageSize: z.coerce.number().int().min(5).max(2500).default(2500), scale: z.coerce.number().min(0.001).max(1).default(1) }).default({ pageSize: 2500, scale: 1 }),
});
export type ConnectionSettings = z.infer<typeof ConnectionSettingsSchema>;

export function parseSettings(raw: unknown): ConnectionSettings {
  return ConnectionSettingsSchema.parse(raw ?? {});
}

interface Secrets {
  clientId?: string;
  clientSecret?: string;
}

// ─── Simulator wiring ─────────────────────────────────────────────────

const g = globalThis as unknown as { __sfmcSims?: Map<string, typeof fetch> };
const sims = (g.__sfmcSims ??= new Map());

export function simulatedAllowed(): boolean {
  const e = env();
  return e.NODE_ENV !== "production" && e.SFMC_ALLOW_SIMULATED;
}

/** Tests: install a specific simulator (fault injection, small pages) for a connection. */
export function setSimulatorFor(connectionId: string, opts: SimOptions | typeof fetch) {
  sims.set(connectionId, typeof opts === "function" ? opts : createSimulatedFetch(opts));
  clearSfmcTokenCache(connectionId);
}
export function clearSimulators() {
  sims.clear();
  clearSfmcTokenCache();
}

function simFetch(conn: SalesforceConnection, settings: ConnectionSettings): typeof fetch {
  let f = sims.get(conn.id);
  if (!f) sims.set(conn.id, (f = createSimulatedFetch({ pageSize: settings.simulator.pageSize, scale: settings.simulator.scale })));
  return f;
}

// ─── Client factory ───────────────────────────────────────────────────

export async function loadConnection(id: string) {
  const conn = await prisma.salesforceConnection.findUnique({ where: { id } });
  if (!conn || conn.archivedAt) throw notFound("Salesforce connection");
  return conn;
}

export function clientFor(conn: SalesforceConnection, mid?: string | null, hooks: { onCall?: ConstructorParameters<typeof SfmcClient>[0]["onCall"] } = {}): SfmcClient {
  const settings = parseSettings(conn.settings);
  const secrets: Secrets = conn.secretsEncrypted ? decryptJson<Secrets>(conn.secretsEncrypted) : {};
  if (conn.kind === "SIMULATED") {
    if (!simulatedAllowed()) throw badRequest("SIMULATED connections are disabled on this deployment.");
    return new SfmcClient({
      connectionId: conn.id,
      authBaseUri: SIM_HOST,
      clientId: secrets.clientId || "simulated",
      clientSecret: secrets.clientSecret || "simulated",
      mid: mid ?? conn.defaultMid,
      settings: { ...settings, minIntervalMs: 0 },
      fetchImpl: simFetch(conn, settings),
      onCall: hooks.onCall,
    });
  }
  if (!conn.authBaseUri || !secrets.clientId || !secrets.clientSecret) throw badRequest("Configure the Authentication Base URI, Client ID and Client Secret first.");
  return new SfmcClient({
    connectionId: conn.id,
    authBaseUri: conn.authBaseUri,
    clientId: secrets.clientId,
    clientSecret: secrets.clientSecret,
    mid: mid ?? conn.defaultMid,
    restBaseUri: conn.restBaseUri,
    soapBaseUri: conn.soapBaseUri,
    settings,
    onCall: hooks.onCall,
  });
}

// ─── CRUD ─────────────────────────────────────────────────────────────

export const ConnectionInputSchema = z.object({
  name: z.string().trim().min(2).max(100),
  kind: z.enum(["LIVE", "SIMULATED"]).default("LIVE"),
  authBaseUri: z.string().trim().max(300).optional().or(z.literal("")),
  restBaseUri: z.string().trim().max(300).optional().or(z.literal("")),
  soapBaseUri: z.string().trim().max(300).optional().or(z.literal("")),
  defaultMid: z.string().trim().regex(/^\d{1,12}$/, "MID is numeric").optional().or(z.literal("")),
  clientId: z.string().trim().max(200).optional(),
  clientSecret: z.string().trim().max(500).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type ConnectionInput = z.infer<typeof ConnectionInputSchema>;

function validatedUri(v: string | undefined): string | null {
  if (!v) return null;
  try {
    const u = normalizeBaseUri(v);
    assertSfmcHost(u);
    return u;
  } catch (err) {
    throw badRequest(isSfmcError(err) ? err.message : "Invalid URI");
  }
}

function hints(s: Secrets) {
  return { clientId: maskSecret(s.clientId), clientSecret: maskSecret(s.clientSecret) };
}

export async function saveConnection(id: string | null, input: ConnectionInput, actor: ArchiveActor) {
  if (input.kind === "SIMULATED" && !simulatedAllowed()) throw badRequest("SIMULATED connections are disabled on this deployment.");
  const existing = id ? await loadConnection(id) : null;
  const current: Secrets = existing?.secretsEncrypted ? decryptJson<Secrets>(existing.secretsEncrypted) : {};
  const secrets: Secrets = { ...current };
  if (input.clientId) secrets.clientId = input.clientId;
  if (input.clientSecret) secrets.clientSecret = input.clientSecret;
  const settings = parseSettings({ ...((existing?.settings as object) ?? {}), ...(input.settings ?? {}) });
  const authBaseUri = input.kind === "SIMULATED" ? SIM_HOST : validatedUri(input.authBaseUri);
  const configured = input.kind === "SIMULATED" || (!!authBaseUri && !!secrets.clientId && !!secrets.clientSecret);
  const data = {
    name: input.name,
    kind: input.kind,
    authBaseUri,
    restBaseUri: input.kind === "SIMULATED" ? null : validatedUri(input.restBaseUri),
    soapBaseUri: input.kind === "SIMULATED" ? null : validatedUri(input.soapBaseUri),
    defaultMid: input.defaultMid || null,
    secretsEncrypted: Object.keys(secrets).length ? encryptJson(secrets) : null,
    secretsHint: hints(secrets) as Prisma.InputJsonValue,
    settings: settings as unknown as Prisma.InputJsonValue,
  };
  const conn = existing
    ? await prisma.salesforceConnection.update({ where: { id: existing.id }, data: { ...data, status: configured ? (existing.status === "NOT_CONFIGURED" ? "CONFIGURED" : existing.status) : "NOT_CONFIGURED" } })
    : await prisma.salesforceConnection.create({ data: { ...data, status: configured ? "CONFIGURED" : "NOT_CONFIGURED", createdById: actor.id } });
  clearSfmcTokenCache(conn.id);
  await archiveAudit({
    actor,
    action: existing ? "archive.connection.updated" : "archive.connection.created",
    entityType: "salesforce_connection",
    entityId: conn.id,
    metadata: { kind: conn.kind, fieldsChanged: Object.keys(input).filter((k) => k !== "clientSecret"), secretChanged: !!input.clientSecret },
  });
  return conn;
}

export async function archiveConnection(id: string, actor: ArchiveActor) {
  await loadConnection(id);
  await prisma.salesforceConnection.update({ where: { id }, data: { archivedAt: new Date(), secretsEncrypted: null, secretsHint: {} } });
  clearSfmcTokenCache(id);
  await archiveAudit({ actor, action: "archive.connection.archived", entityType: "salesforce_connection", entityId: id, metadata: { note: "Credentials erased; archived data retained." } });
}

/** Browser-safe projection. Never includes secrets or tokens. */
export function connectionView(c: SalesforceConnection & { businessUnits?: { mid: string; name: string; selected: boolean; isEnterprise: boolean; parentMid: string | null; source: string }[] }) {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    status: c.status,
    authBaseUri: c.authBaseUri,
    restBaseUri: c.restBaseUri,
    soapBaseUri: c.soapBaseUri,
    enterpriseMid: c.enterpriseMid,
    defaultMid: c.defaultMid,
    secretHints: c.secretsHint as Record<string, string | null>,
    grantedScopes: c.grantedScopes,
    accountInfo: c.accountInfo as Record<string, unknown>,
    capabilities: c.capabilities as unknown as Record<string, CapabilityResult>,
    settings: parseSettings(c.settings),
    lastTestedAt: c.lastTestedAt?.toISOString() ?? null,
    lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
    lastErrorAt: c.lastErrorAt?.toISOString() ?? null,
    lastError: c.lastError,
    businessUnits: c.businessUnits ?? [],
  };
}
export type ConnectionView = ReturnType<typeof connectionView>;

export async function listConnections() {
  const rows = await prisma.salesforceConnection.findMany({
    where: { archivedAt: null },
    orderBy: { createdAt: "asc" },
    include: { businessUnits: { orderBy: [{ isEnterprise: "desc" }, { name: "asc" }], select: { mid: true, name: true, selected: true, isEnterprise: true, parentMid: true, source: true } } },
  });
  return rows.map(connectionView);
}

// ─── Test connection ──────────────────────────────────────────────────

export interface CapabilityResult {
  label: string;
  scope: string;
  status: "ok" | "denied" | "error";
  message?: string;
  ms: number;
}

export async function testConnection(id: string, actor: ArchiveActor) {
  const conn = await loadConnection(id);
  const settings = parseSettings(conn.settings);
  const client = clientFor(conn);
  const started = Date.now();
  try {
    const token = await client.getToken(true);
    let info: Record<string, unknown> = {};
    try {
      info = await client.userInfo();
    } catch (err) {
      info = { userinfoError: (err as Error).message };
    }
    const org = (info.organization ?? {}) as Record<string, unknown>;
    const capabilities: Record<string, CapabilityResult> = {};
    for (const probe of CAPABILITY_PROBES) {
      const t0 = Date.now();
      try {
        if (probe.soap) {
          const def = SOAP_OBJECTS[probe.soap];
          await client.retrieve({
            objectType: def.objectType,
            properties: def.properties.slice(0, 2),
            filter: probe.key === "tracking" || probe.key === "sends" ? { property: probe.key === "tracking" ? "EventDate" : "SendDate", operator: "greaterThan", dateValues: [toSfmcDateValue(new Date(Date.now() - 86_400_000), settings.sourceUtcOffset)] } : undefined,
            queryAllAccounts: "queryAllAccounts" in def ? def.queryAllAccounts : undefined,
          });
        } else if (probe.rest) {
          const def = REST_OBJECTS[probe.rest];
          await client.rest("GET", def.path, { query: { $page: 1, [def.pageSizeParam]: 1 } });
        }
        capabilities[probe.key] = { label: probe.label, scope: probe.scope, status: "ok", ms: Date.now() - t0 };
      } catch (err) {
        const e = err as SfmcError;
        capabilities[probe.key] = { label: probe.label, scope: probe.scope, status: e.kind === "permission" || e.kind === "auth" ? "denied" : "error", message: e.message?.slice(0, 300), ms: Date.now() - t0 };
      }
    }
    const allOk = Object.values(capabilities).every((c) => c.status === "ok");
    await prisma.salesforceConnection.update({
      where: { id },
      data: {
        status: "CONNECTED",
        grantedScopes: token.scope,
        restBaseUri: conn.restBaseUri ?? token.restBaseUri,
        soapBaseUri: conn.soapBaseUri ?? token.soapBaseUri,
        enterpriseMid: org.enterprise_id !== undefined ? String(org.enterprise_id) : conn.enterpriseMid,
        accountInfo: {
          memberId: org.member_id !== undefined ? String(org.member_id) : null,
          enterpriseId: org.enterprise_id !== undefined ? String(org.enterprise_id) : null,
          enterpriseName: org.enterprise_name ?? null,
          accountType: org.account_type ?? null,
          stackKey: org.stack_key ?? null,
          region: org.region ?? null,
          application: ((info.application ?? {}) as Record<string, unknown>).name ?? null,
          userinfoError: info.userinfoError ?? null,
        } as Prisma.InputJsonValue,
        capabilities: capabilities as unknown as Prisma.InputJsonValue,
        lastTestedAt: new Date(),
        lastSuccessAt: new Date(),
        lastError: null,
      },
    });
    const missingScopes = READ_SCOPES_RECOMMENDED.filter((s) => !token.scope.includes(s));
    await archiveAudit({ actor, action: "archive.connection.tested", entityType: "salesforce_connection", entityId: id, metadata: { ok: true, allCapabilities: allOk, missingScopes } });
    return { ok: true, latencyMs: Date.now() - started, scopes: token.scope, missingScopes, capabilities, memberId: org.member_id ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    await prisma.salesforceConnection.update({ where: { id }, data: { status: "ERROR", lastTestedAt: new Date(), lastErrorAt: new Date(), lastError: message.slice(0, 1000) } });
    await archiveAudit({ actor, action: "archive.connection.test_failed", entityType: "salesforce_connection", entityId: id, metadata: { message } });
    return { ok: false, latencyMs: Date.now() - started, message, hint: setupHint(err), scopes: [] as string[], missingScopes: [...READ_SCOPES_RECOMMENDED] as string[], capabilities: {} as Record<string, CapabilityResult> };
  }
}

function setupHint(err: unknown): string {
  if (!isSfmcError(err)) return "Check network access from this server to *.marketingcloudapis.com.";
  if (err.kind === "auth")
    return "Authentication failed. In Marketing Cloud Setup → Apps → Installed Packages, open the package, check the API Integration component is Server-to-Server, copy the Client ID / Secret and the Authentication Base URI, and confirm the package is installed for the MID you selected.";
  if (err.kind === "permission") return "The package authenticated but lacks permission. An administrator must add the read scopes listed below to the API Integration component.";
  if (err.kind === "network") return "The Salesforce host could not be reached from this server (DNS, proxy or firewall).";
  return err.message;
}

// ─── Business Unit discovery ──────────────────────────────────────────

export async function discoverBusinessUnits(id: string, actor: ArchiveActor) {
  const conn = await loadConnection(id);
  const client = clientFor(conn, conn.enterpriseMid ?? conn.defaultMid);
  const found: { mid: string; name: string; parentMid: string | null; customerKey: string | null; raw: Record<string, unknown>; source: string }[] = [];
  let method = "soap:BusinessUnit";
  let warning: string | null = null;
  try {
    let page = await client.retrieve({ objectType: "BusinessUnit", properties: SOAP_OBJECTS.BusinessUnit.properties, queryAllAccounts: true });
    for (;;) {
      for (const r of page.results) {
        const mid = prop(r, "ID");
        if (!mid) continue;
        found.push({ mid, name: prop(r, "Name") ?? mid, parentMid: prop(r, "ParentID") || null, customerKey: prop(r, "CustomerKey"), raw: r, source: method });
      }
      if (!page.moreData || !page.requestId) break;
      page = await client.continueRetrieve(page.requestId, "BusinessUnit");
    }
  } catch (err) {
    warning = `BusinessUnit retrieve unavailable (${(err as Error).message}). Falling back to the token's account identifiers; add other MIDs manually if needed.`;
    method = "userinfo";
    const info = await client.userInfo().catch(() => ({}) as Record<string, unknown>);
    const org = ((info as Record<string, unknown>).organization ?? {}) as Record<string, unknown>;
    for (const [key, label] of [
      ["enterprise_id", "Enterprise account"],
      ["member_id", "Authenticated business unit"],
    ] as const) {
      if (org[key] !== undefined) found.push({ mid: String(org[key]), name: label, parentMid: null, customerKey: null, raw: { [key]: org[key] }, source: method });
    }
  }
  const enterprise = conn.enterpriseMid;
  const existing = new Set((await prisma.salesforceBusinessUnit.findMany({ where: { connectionId: id }, select: { mid: true } })).map((b) => b.mid));
  for (const bu of found) {
    await prisma.salesforceBusinessUnit.upsert({
      where: { connectionId_mid: { connectionId: id, mid: bu.mid } },
      create: { connectionId: id, mid: bu.mid, name: bu.name, parentMid: bu.parentMid === "0" ? null : bu.parentMid, customerKey: bu.customerKey, isEnterprise: bu.mid === enterprise || bu.parentMid === "0", selected: bu.mid === conn.defaultMid, source: bu.source, raw: bu.raw as Prisma.InputJsonValue },
      update: { name: bu.name, parentMid: bu.parentMid === "0" ? null : bu.parentMid, customerKey: bu.customerKey, isEnterprise: bu.mid === enterprise || bu.parentMid === "0", raw: bu.raw as Prisma.InputJsonValue, source: bu.source },
    });
  }
  await archiveAudit({ actor, action: "archive.business_units.discovered", entityType: "salesforce_connection", entityId: id, metadata: { method, count: found.length, new: found.filter((b) => !existing.has(b.mid)).length } });
  return { method, warning, count: found.length };
}

export async function setBusinessUnitSelection(id: string, mids: string[], actor: ArchiveActor) {
  await loadConnection(id);
  await prisma.$transaction([
    prisma.salesforceBusinessUnit.updateMany({ where: { connectionId: id }, data: { selected: false } }),
    prisma.salesforceBusinessUnit.updateMany({ where: { connectionId: id, mid: { in: mids } }, data: { selected: true } }),
  ]);
  await archiveAudit({ actor, action: "archive.business_units.selected", entityType: "salesforce_connection", entityId: id, metadata: { mids } });
}

export async function addManualBusinessUnit(id: string, mid: string, name: string, actor: ArchiveActor) {
  if (!/^\d{1,12}$/.test(mid)) throw badRequest("MID is numeric.");
  await loadConnection(id);
  await prisma.salesforceBusinessUnit.upsert({
    where: { connectionId_mid: { connectionId: id, mid } },
    create: { connectionId: id, mid, name, source: "manual", selected: true },
    update: { name },
  });
  await archiveAudit({ actor, action: "archive.business_units.added", entityType: "salesforce_connection", entityId: id, metadata: { mid } });
}
