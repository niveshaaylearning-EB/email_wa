import "server-only";
import { z } from "zod";
import type { Prisma, Provider, ProviderMode, IntegrationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { decryptJson, encryptJson } from "@/lib/crypto";
import { maskSecret } from "@/lib/mask";
import { audit, type AuditActor } from "@/lib/audit";
import { badRequest } from "@/lib/errors";
import { env } from "@/lib/env";

// ─── Config & secret shapes per provider ──────────────────────────────

export const ZohoCrmConfigSchema = z.object({
  dc: z.string().default("in"),
  /** Extra CRM field API names mirrored into clients.crm_fields for dynamic rules (max 40). */
  extraFields: z.array(z.string().regex(/^[A-Za-z0-9_]+$/)).max(40).default([]),
  statusField: z.string().regex(/^[A-Za-z0-9_]*$/).default(""),
  cityField: z.string().regex(/^[A-Za-z0-9_]*$/).default("Mailing_City"),
  inactiveStatuses: z.array(z.string()).default(["Inactive"]),
  syncIntervalMinutes: z.coerce.number().int().min(15).max(1440).default(60),
});
export type ZohoCrmConfig = z.infer<typeof ZohoCrmConfigSchema>;

export const ZohoMaConfigSchema = z.object({
  dc: z.string().default("in"),
  baseUrl: z.string().url().optional(),
  fromEmail: z.string().email().optional(),
  fromName: z.string().max(100).optional(),
  topicId: z.string().max(50).optional(),
  listPrefix: z.string().max(30).default("NCC"),
});
export type ZohoMaConfig = z.infer<typeof ZohoMaConfigSchema>;

export const DoubleTickConfigSchema = z.object({
  baseUrl: z.string().url().default("https://public.doubletick.io"),
  senderNumber: z.string().optional(),
  /** Docs are inconsistent: curl uses the raw key, SDK examples prefix "key ". */
  authHeaderStyle: z.enum(["raw", "key_prefix"]).default("raw"),
  throttlePerMinute: z.coerce.number().int().min(1).max(30000).default(600),
});
export type DoubleTickConfig = z.infer<typeof DoubleTickConfigSchema>;

export interface ZohoSecrets {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  accountsServer?: string;
  apiDomain?: string;
}

export interface DoubleTickSecrets {
  apiKey?: string;
  webhookSecret?: string;
}

const CONFIG_SCHEMAS = {
  ZOHO_CRM: ZohoCrmConfigSchema,
  ZOHO_MA: ZohoMaConfigSchema,
  DOUBLETICK: DoubleTickConfigSchema,
} as const;

export type ConfigFor<P extends Provider> = P extends "ZOHO_CRM" ? ZohoCrmConfig : P extends "ZOHO_MA" ? ZohoMaConfig : DoubleTickConfig;
export type SecretsFor<P extends Provider> = P extends "DOUBLETICK" ? DoubleTickSecrets : ZohoSecrets;

export const PROVIDER_LABELS: Record<Provider, string> = {
  ZOHO_CRM: "Zoho CRM",
  ZOHO_MA: "Zoho Marketing Automation",
  DOUBLETICK: "DoubleTick WhatsApp",
};

export async function ensureIntegration(provider: Provider) {
  return prisma.integrationSetting.upsert({
    where: { provider },
    create: { provider, mode: "MOCK", config: CONFIG_SCHEMAS[provider].parse({}) as Prisma.InputJsonValue },
    update: {},
  });
}

export interface LoadedIntegration<P extends Provider> {
  provider: P;
  mode: ProviderMode;
  status: IntegrationStatus;
  config: ConfigFor<P>;
  secrets: SecretsFor<P>;
  row: Awaited<ReturnType<typeof ensureIntegration>>;
}

/** Server-only: returns decrypted secrets merged with env fallbacks. Never send to the browser. */
export async function loadIntegration<P extends Provider>(provider: P): Promise<LoadedIntegration<P>> {
  const row = await ensureIntegration(provider);
  const config = CONFIG_SCHEMAS[provider].parse(row.config ?? {}) as ConfigFor<P>;
  let secrets = (row.secretsEncrypted ? decryptJson(row.secretsEncrypted) : {}) as SecretsFor<P>;
  const e = env();
  if (provider === "DOUBLETICK") {
    const s = secrets as DoubleTickSecrets;
    secrets = { apiKey: s.apiKey ?? e.DOUBLETICK_API_KEY, webhookSecret: s.webhookSecret ?? e.DOUBLETICK_WEBHOOK_SECRET } as SecretsFor<P>;
    const c = config as DoubleTickConfig;
    if (!c.senderNumber && e.DOUBLETICK_SENDER_NUMBER) c.senderNumber = e.DOUBLETICK_SENDER_NUMBER;
  } else {
    const s = secrets as ZohoSecrets;
    secrets = { ...s, clientId: s.clientId ?? e.ZOHO_CLIENT_ID, clientSecret: s.clientSecret ?? e.ZOHO_CLIENT_SECRET } as SecretsFor<P>;
  }
  return { provider, mode: row.mode, status: row.status, config, secrets, row };
}

function hintsFor(secrets: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(secrets)) {
    if (typeof v === "string" && v && !["accountsServer", "apiDomain"].includes(k)) out[k] = maskSecret(v);
    if (k === "accountsServer" || k === "apiDomain") out[k] = typeof v === "string" ? v : null;
  }
  return out;
}

export async function saveSecrets<P extends Provider>(provider: P, patch: Partial<SecretsFor<P>>, actor?: AuditActor) {
  const row = await ensureIntegration(provider);
  const current = row.secretsEncrypted ? decryptJson<Record<string, unknown>>(row.secretsEncrypted) : {};
  const merged: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === "") delete merged[k];
    else if (v !== undefined) merged[k] = v;
  }
  await prisma.integrationSetting.update({
    where: { provider },
    data: {
      secretsEncrypted: Object.keys(merged).length ? encryptJson(merged) : null,
      secretsHint: hintsFor(merged) as Prisma.InputJsonValue,
      updatedById: actor?.id,
    },
  });
  if (actor) {
    await audit({
      actor,
      action: "integration.secrets_updated",
      entityType: "integration",
      entityId: provider,
      metadata: { fields: Object.keys(patch).filter((k) => !["accessToken", "accessTokenExpiresAt"].includes(k)) },
    });
  }
}

export async function updateConfig<P extends Provider>(provider: P, patch: Partial<ConfigFor<P>>, actor: AuditActor) {
  const row = await ensureIntegration(provider);
  const next = CONFIG_SCHEMAS[provider].parse({ ...(row.config as object), ...patch });
  await prisma.integrationSetting.update({
    where: { provider },
    data: { config: next as Prisma.InputJsonValue, updatedById: actor.id },
  });
  await audit({ actor, action: "integration.config_updated", entityType: "integration", entityId: provider, metadata: { patch } });
  return next;
}

export async function setMode(provider: Provider, mode: ProviderMode, actor: AuditActor & { role: string }) {
  if (mode === "LIVE") {
    if (actor.role !== "ADMIN") throw badRequest("Only administrators can enable LIVE mode.");
    if (!env().ALLOW_LIVE_SEND && provider !== "ZOHO_CRM") {
      throw badRequest("LIVE mode is disabled on this deployment (ALLOW_LIVE_SEND is not 'true'). This is expected in development and staging.");
    }
    const loaded = await loadIntegration(provider);
    if (provider === "DOUBLETICK" && !(loaded.secrets as DoubleTickSecrets).apiKey) throw badRequest("Configure the DoubleTick API key first.");
    if (provider !== "DOUBLETICK" && !(loaded.secrets as ZohoSecrets).refreshToken) throw badRequest("Connect the Zoho account first.");
    if (loaded.status !== "CONNECTED") throw badRequest("Run a successful connection test before enabling LIVE mode.");
  }
  await prisma.integrationSetting.update({ where: { provider }, data: { mode, updatedById: actor.id } });
  await audit({ actor, action: "integration.mode_changed", entityType: "integration", entityId: provider, metadata: { mode } });
}

export async function recordProviderSuccess(provider: Provider, extra: { accountInfo?: Record<string, unknown>; status?: IntegrationStatus } = {}) {
  const row = await ensureIntegration(provider);
  const usage = (row.apiUsage as Record<string, number>) ?? {};
  const day = new Date().toISOString().slice(0, 10);
  await prisma.integrationSetting.update({
    where: { provider },
    data: {
      lastSuccessAt: new Date(),
      status: extra.status ?? (row.status === "ERROR" || row.status === "CONFIGURED" ? "CONNECTED" : row.status),
      ...(extra.accountInfo ? { accountInfo: extra.accountInfo as Prisma.InputJsonValue } : {}),
      apiUsage: { ...usage, [day]: (usage[day] ?? 0) + 1, total: (usage.total ?? 0) + 1 },
    },
  });
}

export async function recordProviderError(provider: Provider, message: string) {
  await ensureIntegration(provider);
  await prisma.integrationSetting.update({
    where: { provider },
    data: { lastErrorAt: new Date(), lastError: message.slice(0, 1000), status: "ERROR" },
  });
}

/** Browser-safe view (no secrets, only masked hints). */
export async function listIntegrationsForUi() {
  const rows = await Promise.all((["ZOHO_CRM", "ZOHO_MA", "DOUBLETICK"] as Provider[]).map(ensureIntegration));
  const e = env();
  return rows.map((r) => {
    const hints = (r.secretsHint ?? {}) as Record<string, string | null>;
    const envHints: Record<string, string | null> = {};
    if (r.provider === "DOUBLETICK") {
      if (!hints.apiKey && e.DOUBLETICK_API_KEY) envHints.apiKey = `${maskSecret(e.DOUBLETICK_API_KEY)} (env)`;
      if (!hints.webhookSecret && e.DOUBLETICK_WEBHOOK_SECRET) envHints.webhookSecret = `${maskSecret(e.DOUBLETICK_WEBHOOK_SECRET)} (env)`;
    } else {
      if (!hints.clientId && e.ZOHO_CLIENT_ID) envHints.clientId = `${maskSecret(e.ZOHO_CLIENT_ID)} (env)`;
      if (!hints.clientSecret && e.ZOHO_CLIENT_SECRET) envHints.clientSecret = `${maskSecret(e.ZOHO_CLIENT_SECRET)} (env)`;
    }
    return {
      provider: r.provider,
      label: PROVIDER_LABELS[r.provider],
      mode: r.mode,
      status: r.status,
      config: r.config as Record<string, unknown>,
      secretHints: { ...envHints, ...hints },
      accountInfo: r.accountInfo as Record<string, unknown>,
      apiUsage: r.apiUsage as Record<string, number>,
      lastSuccessAt: r.lastSuccessAt?.toISOString() ?? null,
      lastErrorAt: r.lastErrorAt?.toISOString() ?? null,
      lastError: r.lastError,
      lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
    };
  });
}
export type IntegrationView = Awaited<ReturnType<typeof listIntegrationsForUi>>[number];

/** Defence-in-depth gate called by every real send path immediately before the HTTP call. */
export async function assertLiveSendAllowed(provider: Provider) {
  if (!env().ALLOW_LIVE_SEND) throw new Error("ALLOW_LIVE_SEND is not enabled on this deployment");
  const row = await ensureIntegration(provider);
  if (row.mode !== "LIVE") throw new Error(`${PROVIDER_LABELS[provider]} is in ${row.mode} mode`);
}
