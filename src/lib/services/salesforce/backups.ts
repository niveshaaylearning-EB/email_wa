/**
 * Backup orchestration (Backup Center).
 *
 * A backup job is a set of datasets processed sequentially by a chain of short
 * "sfmc.backup.step" queue jobs (one dataset slice per step). Planning happens in stages
 * because later datasets depend on earlier results:
 *   stage 1: BUs, folders, content categories, lists, subscribers, send jobs, triggered
 *            sends, journeys, automations, query definitions
 *   stage 2: DE inventory (needs folder paths), content assets (needs category paths),
 *            tracking events per JobID (needs the Send objects)
 *   stage 3: DE rows (needs DE schemas)
 * A lease (lease_until) guarantees a single runner per job; an expired lease lets the
 * scheduler tick resume an interrupted job.
 */
import "server-only";
import { z } from "zod";
import type { Prisma, SalesforceBackupDataset, SfDatasetKind } from "@prisma/client";
import { prisma } from "@/lib/db";
import { badRequest, conflict, notFound } from "@/lib/errors";
import { enqueue } from "@/lib/queue";
import { REST_OBJECTS, SOAP_OBJECTS, TRACKING_KINDS, type BackupDataType } from "@/lib/salesforce/objects";
import { SOAP_PAGE_LIMIT, parseRetrieveResponse, prop, type SoapFilter } from "@/lib/salesforce/soap";
import { toSfmcDateValue } from "@/lib/salesforce/dates";
import { getObject } from "@/lib/salesforce/storage";
import { loadConnection, parseSettings, type ConnectionSettings } from "./connections";
import { runDatasetSlice } from "./extract";
import { rollupStatus, verifyAndSeal } from "./verification";
import { writeJobManifest } from "./manifests";
import { archiveAudit, archiveCode, extractionLog, type ArchiveActor } from "./audit";
import { archiveHealth } from "./health";
import { planContentFiles } from "./files";
import type { DatasetParams } from "./types";

export const BackupRequestSchema = z.object({
  connectionId: z.string().min(1),
  mids: z.array(z.string().regex(/^\d{1,12}$/)).min(1).max(50),
  dataTypes: z.array(z.string()).min(1),
  deKeys: z.array(z.string().max(200)).max(5000).optional(),
  jobIds: z.array(z.string().regex(/^\d{1,15}$/)).max(5000).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
  mode: z.enum(["FULL", "INCREMENTAL"]).default("FULL"),
  /** INCREMENTAL: also re-extract tracking for jobs sent within this many days (opens/clicks keep accruing). */
  refreshRecentDays: z.coerce.number().int().min(0).max(120).default(14),
});
export type BackupRequest = z.infer<typeof BackupRequestSchema>;

const LEASE_MS = 5 * 60_000;
const TERMINAL_JOB = new Set(["COMPLETED", "COMPLETED_WITH_GAPS", "FAILED", "CANCELLED"]);

interface JobScope {
  dataTypes: BackupDataType[];
  deKeys?: string[];
  jobIds?: string[];
  dateFrom?: string;
  dateTo?: string;
  refreshRecentDays: number;
  stage: number;
}

function pageLimit(conn: { kind: string }, settings: ConnectionSettings) {
  return conn.kind === "SIMULATED" ? settings.simulator.pageSize : SOAP_PAGE_LIMIT;
}

function soapParams(objectKey: keyof typeof SOAP_OBJECTS, limit: number, extra: Partial<DatasetParams> = {}, filter?: SoapFilter): DatasetParams {
  const def = SOAP_OBJECTS[objectKey];
  return {
    channel: "soap",
    pageLimit: limit,
    requests: [{ objectType: def.objectType, properties: [...def.properties], ...(filter ? { filter } : {}), ...("queryAllAccounts" in def && def.queryAllAccounts ? { queryAllAccounts: true } : {}) }],
    ...extra,
  };
}

function restParams(key: keyof typeof REST_OBJECTS, extra: Partial<DatasetParams> = {}): DatasetParams {
  const def = REST_OBJECTS[key];
  return { channel: "rest", pageLimit: def.pageSize, rest: { path: def.path, pageSize: def.pageSize, pageSizeParam: def.pageSizeParam, extraQuery: "extraQuery" in def ? def.extraQuery : undefined }, ...extra };
}

type NewDataset = { kind: SfDatasetKind; objectType: string; sourceKey?: string | null; label: string; params: DatasetParams; mid: string };

async function createDatasets(jobId: string, connectionId: string, isSimulated: boolean, items: NewDataset[], createdById?: string | null) {
  for (const it of items) {
    await prisma.salesforceBackupDataset.create({
      data: { backupJobId: jobId, connectionId, mid: it.mid, kind: it.kind, objectType: it.objectType, sourceKey: it.sourceKey ?? null, label: it.label, params: it.params as unknown as Prisma.InputJsonValue, isSimulated, createdById: createdById ?? null },
    });
  }
  return items.length;
}

// ─── Create ───────────────────────────────────────────────────────────

export async function createBackupJob(input: BackupRequest, actor: ArchiveActor | null, opts: { scheduleId?: string; parentJobId?: string; allowConcurrent?: boolean } = {}) {
  const conn = await loadConnection(input.connectionId);
  if (conn.kind === "LIVE" && conn.status !== "CONNECTED") throw badRequest("Run a successful connection test before starting a backup.");
  const health = await archiveHealth();
  if (conn.kind === "LIVE" && !health.encodingOk) throw badRequest(health.encodingMessage!);
  const active = await prisma.salesforceBackupJob.findFirst({ where: { connectionId: conn.id, status: { in: ["QUEUED", "RUNNING", "CANCELLING"] } }, select: { code: true } });
  if (active && !opts.allowConcurrent) throw conflict(`Backup ${active.code} is still running for this connection. Only one backup runs per connection at a time to respect Salesforce API limits.`);
  const settings = parseSettings(conn.settings);
  let dateFrom = input.dateFrom;
  if (input.mode === "INCREMENTAL" && !dateFrom) {
    const last = await prisma.salesforceBackupJob.findFirst({ where: { connectionId: conn.id, status: { in: ["COMPLETED", "COMPLETED_WITH_GAPS"] } }, orderBy: { finishedAt: "desc" }, select: { startedAt: true } });
    if (last?.startedAt) dateFrom = new Date(last.startedAt.getTime() - 86_400_000).toISOString();
  }
  const scope: JobScope = {
    dataTypes: input.dataTypes as BackupDataType[],
    deKeys: input.deKeys?.length ? input.deKeys : undefined,
    jobIds: input.jobIds?.length ? input.jobIds : undefined,
    dateFrom,
    dateTo: input.dateTo,
    refreshRecentDays: input.refreshRecentDays,
    stage: 1,
  };
  const job = await prisma.salesforceBackupJob.create({
    data: {
      code: archiveCode("BKP"),
      connectionId: conn.id,
      mids: input.mids,
      mode: input.mode,
      scope: scope as unknown as Prisma.InputJsonValue,
      isSimulated: conn.kind === "SIMULATED",
      createdById: actor?.id ?? null,
      createdByEmail: actor?.email ?? "scheduler",
      scheduleId: opts.scheduleId ?? null,
      parentJobId: opts.parentJobId ?? null,
    },
  });
  await planStage(job.id, 1, settings);
  await archiveAudit({ actor, action: "archive.backup.created", entityType: "salesforce_backup_job", entityId: job.id, metadata: { code: job.code, mode: job.mode, mids: input.mids, dataTypes: input.dataTypes, deKeys: input.deKeys?.length ?? 0 } });
  await enqueue("sfmc.backup.step", { backupJobId: job.id }, { jobId: `sfmc-step-${job.id}-0` });
  return job;
}

// ─── Planning ─────────────────────────────────────────────────────────

async function folderPaths(jobId: string, mid: string): Promise<Record<string, string>> {
  const ds = await prisma.salesforceBackupDataset.findFirst({ where: { backupJobId: jobId, mid, kind: "DATA_FOLDERS", status: "EXTRACTED" } });
  if (!ds) return {};
  const pages = await prisma.salesforceBackupPage.findMany({ where: { datasetId: ds.id }, orderBy: { pageNo: "asc" } });
  const nodes = new Map<string, { name: string; parent: string | null }>();
  for (const p of pages) {
    const parsed = parseRetrieveResponse((await getObject(p.storageKey)).toString("utf8"), 200);
    for (const r of parsed.results) {
      const id = prop(r, "ID");
      if (id) nodes.set(id, { name: prop(r, "Name") ?? id, parent: prop(r, "ParentFolder.ID") });
    }
  }
  const out: Record<string, string> = {};
  for (const id of nodes.keys()) {
    const parts: string[] = [];
    let cur: string | null = id;
    for (let i = 0; cur && nodes.has(cur) && i < 30; i++) {
      parts.unshift(nodes.get(cur)!.name);
      cur = nodes.get(cur)!.parent;
    }
    out[id] = parts.join(" / ");
  }
  return out;
}

async function categoryPaths(jobId: string, mid: string): Promise<Record<string, string>> {
  const ds = await prisma.salesforceBackupDataset.findFirst({ where: { backupJobId: jobId, mid, kind: "CONTENT_CATEGORIES", status: "EXTRACTED" } });
  if (!ds) return {};
  const nodes = new Map<string, { name: string; parent: string | null }>();
  for (const p of await prisma.salesforceBackupPage.findMany({ where: { datasetId: ds.id }, orderBy: { pageNo: "asc" } })) {
    const json = JSON.parse((await getObject(p.storageKey)).toString("utf8")) as { items?: { id: number; name: string; parentId?: number }[] };
    for (const c of json.items ?? []) nodes.set(String(c.id), { name: c.name, parent: c.parentId ? String(c.parentId) : null });
  }
  const out: Record<string, string> = {};
  for (const id of nodes.keys()) {
    const parts: string[] = [];
    let cur: string | null = id;
    for (let i = 0; cur && nodes.has(cur) && i < 30; i++) {
      parts.unshift(nodes.get(cur)!.name);
      cur = nodes.get(cur)!.parent;
    }
    out[id] = parts.join(" / ");
  }
  return out;
}

async function planStage(jobId: string, stage: number, settings: ConnectionSettings): Promise<number> {
  const job = await prisma.salesforceBackupJob.findUniqueOrThrow({ where: { id: jobId }, include: { connection: true } });
  const scope = job.scope as unknown as JobScope;
  const types = new Set(scope.dataTypes);
  const limit = pageLimit(job.connection, settings);
  const tz = settings.sourceUtcOffset;
  const items: NewDataset[] = [];
  const wantsTracking = [...types].some((t) => t.startsWith("tracking_"));

  for (const mid of job.mids) {
    if (stage === 1) {
      if (types.has("business_units") && mid === job.mids[0]) items.push({ mid, kind: "BUSINESS_UNITS", objectType: "BusinessUnit", label: "Business Units", params: soapParams("BusinessUnit", limit) });
      if (types.has("folders") || types.has("de_metadata") || types.has("de_rows")) items.push({ mid, kind: "DATA_FOLDERS", objectType: "DataFolder", label: "Data folders", params: soapParams("DataFolder", limit) });
      if (types.has("subscribers")) items.push({ mid, kind: "SUBSCRIBERS", objectType: "Subscriber", label: "Subscribers", params: soapParams("Subscriber", limit) });
      if (types.has("lists")) items.push({ mid, kind: "LISTS", objectType: "List", label: "Lists", params: soapParams("List", limit) });
      if (types.has("email_jobs") || wantsTracking) {
        const filter =
          scope.dateFrom && scope.dateTo
            ? { property: "SendDate", operator: "between" as const, dateValues: [toSfmcDateValue(new Date(scope.dateFrom), tz), toSfmcDateValue(new Date(scope.dateTo), tz)] }
            : scope.dateFrom
              ? { property: "SendDate", operator: "greaterThan" as const, dateValues: [toSfmcDateValue(new Date(scope.dateFrom), tz)] }
              : scope.dateTo
                ? { property: "SendDate", operator: "lessThan" as const, dateValues: [toSfmcDateValue(new Date(scope.dateTo), tz)] }
                : undefined;
        items.push({ mid, kind: "EMAIL_JOBS", objectType: "Send", label: `Email send jobs${filter ? " (date window)" : ""}`, params: soapParams("Send", limit, { window: { from: scope.dateFrom, to: scope.dateTo }, sourceTimezoneOffset: tz }, filter) });
      }
      if (types.has("triggered_sends")) items.push({ mid, kind: "TRIGGERED_SENDS", objectType: "TriggeredSendDefinition", label: "Triggered send definitions", params: soapParams("TriggeredSendDefinition", limit) });
      if (types.has("journeys")) items.push({ mid, kind: "JOURNEYS", objectType: "interaction/v1/interactions", label: "Journey Builder", params: restParams("Journeys") });
      if (types.has("automations")) {
        items.push({ mid, kind: "AUTOMATIONS", objectType: "Automation", label: "Automation Studio automations", params: soapParams("Automation", limit) });
        items.push({ mid, kind: "QUERY_DEFINITIONS", objectType: "QueryDefinition", label: "SQL query activities", params: soapParams("QueryDefinition", limit) });
      }
      if (types.has("content")) items.push({ mid, kind: "CONTENT_CATEGORIES", objectType: "asset/v1/content/categories", label: "Content Builder folders", params: restParams("ContentCategories") });
    }
    if (stage === 2) {
      if (types.has("de_metadata") || types.has("de_rows")) {
        items.push({ mid, kind: "DE_INVENTORY", objectType: "DataExtension", label: "Data Extension inventory & schemas", params: soapParams("DataExtension", limit, { folderPaths: await folderPaths(jobId, mid) }) });
      }
      if (types.has("content")) items.push({ mid, kind: "CONTENT_ASSETS", objectType: "asset/v1/content/assets", label: "Content Builder assets", params: restParams("ContentAssets", { categoryPaths: await categoryPaths(jobId, mid) }) });
      if (types.has("emails")) {
        // Every email referenced by an archived send job, fetched in small batches (bodies are large).
        const ids = (await prisma.salesforceEmailJob.findMany({ where: { connectionId: job.connectionId, mid, emailId: { not: null } }, distinct: ["emailId"], select: { emailId: true }, orderBy: { emailId: "asc" } })).map((e) => e.emailId!);
        if (ids.length) {
          const def = SOAP_OBJECTS.Email;
          const requests = [];
          for (let i = 0; i < ids.length; i += 25) {
            const batch = ids.slice(i, i + 25);
            requests.push({ objectType: def.objectType, properties: [...def.properties], filter: batch.length === 1 ? { property: "ID", operator: "equals" as const, values: batch } : { property: "ID", operator: "IN" as const, values: batch } });
          }
          items.push({ mid, kind: "EMAILS", objectType: "Email", label: `Email content (${ids.length} emails used in sends)`, params: { channel: "soap", pageLimit: limit, requests, sourceTimezoneOffset: tz } });
        } else {
          await extractionLog({ backupJobId: jobId, level: "warn", message: `Email content skipped for MID ${mid}: no archived send jobs reference an email yet (back up send jobs first).` });
        }
      }
      if (wantsTracking) {
        const sendsDs = await prisma.salesforceBackupDataset.findFirst({ where: { backupJobId: jobId, mid, kind: "EMAIL_JOBS", status: "EXTRACTED" } });
        let jobs = sendsDs ? await prisma.salesforceEmailJob.findMany({ where: { connectionId: job.connectionId, mid, datasetId: sendsDs.id }, orderBy: { sendDate: "desc" } }) : [];
        if (scope.jobIds) jobs = jobs.filter((j) => scope.jobIds!.includes(j.jobId));
        if (job.mode === "INCREMENTAL" && scope.dateFrom) {
          const refreshCutoff = Date.now() - scope.refreshRecentDays * 86_400_000;
          const from = new Date(scope.dateFrom).getTime();
          jobs = jobs.filter((j) => {
            const t = (j.sentDate ?? j.sendDate)?.getTime() ?? 0;
            return t >= Math.min(from, refreshCutoff);
          });
        }
        for (const ej of jobs) {
          for (const t of Object.values(TRACKING_KINDS)) {
            if (!types.has(`tracking_${t.eventType.toLowerCase()}` as BackupDataType)) continue;
            items.push({
              mid,
              kind: t.kind,
              objectType: t.object,
              sourceKey: ej.jobId,
              label: `${t.label} · Job ${ej.jobId}${ej.emailName ? ` · ${ej.emailName}` : ""}`,
              params: soapParams(t.object, limit, { jobId: ej.jobId, sendDate: (ej.sentDate ?? ej.sendDate)?.toISOString() ?? null, sourceTimezoneOffset: tz }, { property: "SendID", operator: "equals", values: [ej.jobId] }),
            });
          }
        }
      }
    }
    if (stage === 3 && types.has("content_files")) {
      const { files, allowedHosts } = await planContentFiles(job.connectionId, mid);
      if (files.length) items.push({ mid, kind: "CONTENT_FILES", objectType: "published files", label: `Images & PDFs (${files.length} files)`, params: { channel: "files", pageLimit: 1, files, allowedHosts } });
      else await extractionLog({ backupJobId: jobId, level: "info", message: `No new content files to download for MID ${mid}.` });
    }
    if (stage === 3 && types.has("de_rows")) {
      const inv = await prisma.salesforceBackupDataset.findFirst({ where: { backupJobId: jobId, mid, kind: "DE_INVENTORY", status: "EXTRACTED" } });
      if (inv) {
        const des = await prisma.salesforceDataExtension.findMany({
          where: { connectionId: job.connectionId, mid, inventoryDatasetId: inv.id, ...(scope.deKeys ? { customerKey: { in: scope.deKeys } } : {}) },
          include: { fields: { orderBy: [{ ordinal: "asc" }, { name: "asc" }] } },
          orderBy: { name: "asc" },
        });
        for (const de of des) {
          if (!de.fields.length) {
            await extractionLog({ backupJobId: jobId, level: "warn", message: `Skipped rows of ${de.name}: no fields were retrievable`, data: { customerKey: de.customerKey } });
            continue;
          }
          items.push({
            mid,
            kind: "DE_ROWS",
            objectType: `DataExtensionObject[${de.customerKey}]`,
            sourceKey: de.customerKey,
            label: `Rows · ${de.name}`,
            // Rows via the REST rowset resource (paged, with Salesforce's own row count). SOAP
            // DataExtensionObject retrieve is refused for some installed-package users.
            params: {
              channel: "rest",
              pageLimit: limit,
              rest: { path: `/data/v1/customobjectdata/key/${encodeURIComponent(de.customerKey)}/rowset`, pageSize: limit, pageSizeParam: "$pageSize" },
              dataExtensionId: de.id,
              primaryKeyFields: de.fields.filter((f) => f.isPrimaryKey).map((f) => f.name),
              schema: de.fields.map((f) => ({ name: f.name, fieldType: f.fieldType, isPrimaryKey: f.isPrimaryKey, isRequired: f.isRequired, maxLength: f.maxLength })),
            },
          });
        }
        if (scope.deKeys) {
          const found = new Set(des.map((d) => d.customerKey));
          const missing = scope.deKeys.filter((k) => !found.has(k));
          if (missing.length) await extractionLog({ backupJobId: jobId, level: "warn", message: `${missing.length} selected Data Extension(s) were not visible to the API user in MID ${mid}`, data: { missing: missing.slice(0, 50) } });
        }
      }
    }
  }
  // Tracking: sent events first (most important for audit), then the rest.
  const order: Partial<Record<SfDatasetKind, number>> = { TRACKING_SENT: 0, TRACKING_NOTSENT: 1, TRACKING_BOUNCE: 2, TRACKING_UNSUB: 3, TRACKING_OPEN: 4, TRACKING_CLICK: 5 };
  items.sort((a, b) => (order[a.kind] ?? -1) - (order[b.kind] ?? -1));
  await createDatasets(jobId, job.connectionId, job.isSimulated, items, job.createdById);
  await prisma.salesforceBackupJob.update({ where: { id: jobId }, data: { scope: { ...scope, stage } as unknown as Prisma.InputJsonValue } });
  await extractionLog({ backupJobId: jobId, level: "info", message: `Planned stage ${stage}: ${items.length} dataset(s)` });
  return items.length;
}

// ─── Runner ───────────────────────────────────────────────────────────

async function claimLease(jobId: string): Promise<boolean> {
  const now = new Date();
  const r = await prisma.salesforceBackupJob.updateMany({
    where: { id: jobId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }], status: { in: ["QUEUED", "RUNNING", "CANCELLING"] } },
    data: { leaseUntil: new Date(now.getTime() + LEASE_MS), stepCount: { increment: 1 } },
  });
  return r.count === 1;
}

async function releaseLease(jobId: string) {
  await prisma.salesforceBackupJob.update({ where: { id: jobId }, data: { leaseUntil: null } }).catch(() => undefined);
}

/** Supersede older datasets of the same object once a newer one is verified. */
async function supersede(d: SalesforceBackupDataset) {
  if (d.status !== "EXTRACTED" || d.verificationStatus === "FAILED") return;
  const older = await prisma.salesforceBackupDataset.findMany({
    where: { id: { not: d.id }, connectionId: d.connectionId, mid: d.mid, kind: d.kind, sourceKey: d.sourceKey, supersededById: null, status: { in: ["EXTRACTED", "NOT_RETRIEVABLE", "NOT_ACCESSIBLE", "FAILED"] }, createdAt: { lt: d.createdAt } },
  });
  for (const o of older) {
    const isTracking = d.kind.startsWith("TRACKING_");
    if (isTracking && o.recordsExtracted > d.recordsExtracted) {
      // Newer extraction returned fewer events (e.g. retention expiry): the earlier, more complete copy stays authoritative.
      await prisma.salesforceBackupDataset.update({ where: { id: d.id }, data: { supersededById: o.id } });
      await extractionLog({ backupJobId: d.backupJobId, datasetId: d.id, level: "warn", message: `Newer extraction returned fewer events (${d.recordsExtracted} < ${o.recordsExtracted}); earlier dataset ${o.id} remains authoritative.` });
      return;
    }
    await prisma.salesforceBackupDataset.update({ where: { id: o.id }, data: { supersededById: d.id } });
  }
}

export async function backupStep(backupJobId: string): Promise<void> {
  if (!(await claimLease(backupJobId))) return;
  let next: { delayMs: number } | null = null;
  try {
    let job = await prisma.salesforceBackupJob.findUniqueOrThrow({ where: { id: backupJobId }, include: { connection: true } });
    if (TERMINAL_JOB.has(job.status)) return;
    const settings = parseSettings(job.connection.settings);
    if (job.status === "QUEUED") job = await prisma.salesforceBackupJob.update({ where: { id: job.id }, data: { status: "RUNNING", startedAt: new Date() }, include: { connection: true } });

    if (job.cancelRequestedAt) {
      const open = await prisma.salesforceBackupDataset.findMany({ where: { backupJobId, status: { in: ["PENDING", "RUNNING"] } } });
      for (const d of open) {
        await prisma.salesforceBackupDataset.update({ where: { id: d.id }, data: { status: "CANCELLED", finishedAt: new Date(), errorMessage: "Cancelled by user" } });
        await verifyAndSeal(d.id);
      }
      await finalize(backupJobId, "CANCELLED");
      return;
    }

    // Up to `parallelDatasets` datasets per step, extracted concurrently. Each dataset keeps its
    // own checkpoint and transaction, and the per-connection limiter caps requests in flight.
    const open = await prisma.salesforceBackupDataset.findMany({ where: { backupJobId, status: { in: ["PENDING", "RUNNING"] } }, orderBy: { createdAt: "asc" }, take: settings.parallelDatasets });
    if (open.length) {
      const results = await Promise.all(
        open.map(async (ds) => {
          const outcome = await runDatasetSlice(ds.id, settings.pagesPerStep);
          const after = await prisma.salesforceBackupDataset.findUniqueOrThrow({ where: { id: ds.id } });
          if (!after.sealedAt && ["EXTRACTED", "FAILED", "NOT_ACCESSIBLE", "NOT_RETRIEVABLE", "CANCELLED"].includes(after.status)) {
            await verifyAndSeal(after.id);
            await supersede(await prisma.salesforceBackupDataset.findUniqueOrThrow({ where: { id: ds.id } }));
          }
          return { outcome, retries: ((after.checkpoint ?? {}) as { stepRetries?: number }).stepRetries ?? 0 };
        }),
      );
      const waiting = results.filter((r) => r.outcome === "retry_later");
      next = { delayMs: waiting.length === results.length ? Math.min(15 * 60_000, 15_000 * 2 ** Math.max(...waiting.map((r) => r.retries))) : 0 };
      return;
    }

    const scope = job.scope as unknown as JobScope;
    for (let stage = scope.stage + 1; stage <= 3; stage++) {
      const planned = await planStage(backupJobId, stage, settings);
      if (planned > 0) {
        next = { delayMs: 0 };
        return;
      }
    }
    await finalize(backupJobId);
  } finally {
    await releaseLease(backupJobId);
    if (next) {
      const job = await prisma.salesforceBackupJob.findUnique({ where: { id: backupJobId }, select: { stepCount: true } });
      await enqueue("sfmc.backup.step", { backupJobId }, { delayMs: next.delayMs, jobId: `sfmc-step-${backupJobId}-${job?.stepCount ?? 0}` });
    }
  }
}

async function finalize(backupJobId: string, forced?: "CANCELLED") {
  const datasets = await prisma.salesforceBackupDataset.findMany({ where: { backupJobId } });
  const current = datasets.filter((d) => !d.supersededById || datasets.every((x) => x.id !== d.supersededById));
  const notes: string[] = [];
  const by = (pred: (d: SalesforceBackupDataset) => boolean) => current.filter(pred);
  const inaccessible = by((d) => d.status === "NOT_ACCESSIBLE");
  const notRetrievable = by((d) => d.status === "NOT_RETRIEVABLE");
  const failed = by((d) => d.status === "FAILED");
  const cancelled = by((d) => d.status === "CANCELLED");
  const limited = by((d) => d.verificationStatus === "PARTIALLY_VERIFIED");
  const vFailed = by((d) => d.verificationStatus === "FAILED" && d.status === "EXTRACTED");
  if (inaccessible.length) notes.push(`${inaccessible.length} dataset(s) NOT ACCESSIBLE with the current API permissions: ${inaccessible.slice(0, 6).map((d) => d.label).join("; ")}`);
  if (notRetrievable.length) notes.push(`${notRetrievable.length} dataset(s) NOT RETRIEVABLE FROM THIS SOURCE (outside retention window): ${notRetrievable.slice(0, 6).map((d) => d.label).join("; ")}`);
  if (failed.length) notes.push(`${failed.length} dataset(s) FAILED during extraction — use "Retry failed" to re-extract.`);
  if (vFailed.length) notes.push(`${vFailed.length} dataset(s) extracted but FAILED verification.`);
  if (limited.length) notes.push(`${limited.length} dataset(s) PARTIALLY VERIFIED (no independent source count, or anomalies found).`);
  if (cancelled.length) notes.push(`${cancelled.length} dataset(s) cancelled before completion.`);
  const extracted = by((d) => d.status === "EXTRACTED");
  const status = forced ?? (current.length && extracted.length === current.length ? "COMPLETED" : extracted.length === 0 && (failed.length || inaccessible.length) ? "FAILED" : "COMPLETED_WITH_GAPS");
  const verificationStatus = forced ? "UNVERIFIED" : rollupStatus(current.map((d) => d.verificationStatus));
  const errors = await prisma.salesforceExtractionError.count({ where: { backupJobId } });
  const stats = {
    datasets: current.length,
    datasetsByStatus: Object.fromEntries(["EXTRACTED", "FAILED", "NOT_ACCESSIBLE", "NOT_RETRIEVABLE", "CANCELLED"].map((s) => [s, current.filter((d) => d.status === s).length])),
    verificationByStatus: Object.fromEntries(["VERIFIED", "PARTIALLY_VERIFIED", "UNVERIFIED", "FAILED", "NOT_ACCESSIBLE", "NOT_RETRIEVABLE"].map((s) => [s, current.filter((d) => d.verificationStatus === s).length])),
    records: current.reduce((a, d) => a + d.recordsExtracted, 0),
    pages: current.reduce((a, d) => a + d.pagesFetched, 0),
    apiCalls: datasets.reduce((a, d) => a + d.apiCalls, 0),
    retries: datasets.reduce((a, d) => a + d.retries, 0),
    storageBytes: datasets.reduce((a, d) => a + Number(d.bytesStored), 0),
    errors,
    dataExtensions: current.filter((d) => d.kind === "DE_ROWS").length,
    emailJobsTracked: new Set(current.filter((d) => d.kind === "TRACKING_SENT").map((d) => d.sourceKey)).size,
  };
  await prisma.salesforceBackupJob.update({
    where: { id: backupJobId },
    data: { status, verificationStatus, verificationNotes: notes as Prisma.InputJsonValue, stats: stats as Prisma.InputJsonValue, finishedAt: new Date() },
  });
  await writeJobManifest(backupJobId);
  await extractionLog({ backupJobId, level: status === "COMPLETED" ? "info" : "warn", message: `Backup ${status} · verification ${verificationStatus}`, data: { notes } });
}

// ─── Controls ─────────────────────────────────────────────────────────

export async function cancelBackup(id: string, actor: ArchiveActor) {
  const job = await prisma.salesforceBackupJob.findUnique({ where: { id } });
  if (!job) throw notFound("Backup job");
  if (TERMINAL_JOB.has(job.status)) throw badRequest("This backup has already finished.");
  await prisma.salesforceBackupJob.update({ where: { id }, data: { cancelRequestedAt: new Date(), status: "CANCELLING" } });
  await archiveAudit({ actor, action: "archive.backup.cancel_requested", entityType: "salesforce_backup_job", entityId: id, metadata: { code: job.code } });
  await enqueue("sfmc.backup.step", { backupJobId: id }, { jobId: `sfmc-cancel-${id}` });
}

/** Resume an interrupted job (expired lease / lost queue message). Idempotent. */
export async function resumeBackup(id: string, actor: ArchiveActor | null) {
  const job = await prisma.salesforceBackupJob.findUnique({ where: { id } });
  if (!job) throw notFound("Backup job");
  if (TERMINAL_JOB.has(job.status)) throw badRequest("This backup has already finished. Use 'Retry failed' to re-extract failed datasets.");
  await prisma.salesforceBackupJob.update({ where: { id }, data: { leaseUntil: null } });
  await enqueue("sfmc.backup.step", { backupJobId: id }, { jobId: `sfmc-resume-${id}-${Date.now()}` });
  if (actor) await archiveAudit({ actor, action: "archive.backup.resumed", entityType: "salesforce_backup_job", entityId: id, metadata: { code: job.code } });
}

/** Re-extract FAILED / CANCELLED datasets of a finished job as new datasets (originals stay sealed). */
export async function retryFailedDatasets(id: string, actor: ArchiveActor) {
  const job = await prisma.salesforceBackupJob.findUnique({ where: { id } });
  if (!job) throw notFound("Backup job");
  if (!TERMINAL_JOB.has(job.status)) throw badRequest("Wait for the backup to finish (or cancel it) before retrying.");
  const failed = await prisma.salesforceBackupDataset.findMany({ where: { backupJobId: id, status: { in: ["FAILED", "CANCELLED"] }, supersededById: null } });
  if (!failed.length) throw badRequest("There are no failed datasets to retry.");
  for (const f of failed) {
    const params = f.params as unknown as DatasetParams;
    const nd = await prisma.salesforceBackupDataset.create({
      data: { backupJobId: id, connectionId: f.connectionId, mid: f.mid, kind: f.kind, objectType: f.objectType, sourceKey: f.sourceKey, label: f.label, params: params as unknown as Prisma.InputJsonValue, isSimulated: f.isSimulated, createdById: actor.id },
    });
    await prisma.salesforceBackupDataset.update({ where: { id: f.id }, data: { supersededById: nd.id } });
  }
  await prisma.salesforceBackupJob.update({ where: { id }, data: { status: "RUNNING", finishedAt: null, cancelRequestedAt: null, leaseUntil: null } });
  await archiveAudit({ actor, action: "archive.backup.retry_failed", entityType: "salesforce_backup_job", entityId: id, metadata: { code: job.code, datasets: failed.length } });
  await enqueue("sfmc.backup.step", { backupJobId: id }, { jobId: `sfmc-retry-${id}-${Date.now()}` });
  return failed.length;
}

// ─── Schedules ────────────────────────────────────────────────────────

export const ScheduleSchema = z.object({
  connectionId: z.string().min(1),
  name: z.string().trim().min(2).max(100),
  mids: z.array(z.string().regex(/^\d{1,12}$/)).min(1),
  dataTypes: z.array(z.string()).min(1),
  intervalHours: z.coerce.number().int().min(6).max(24 * 31),
  firstRunAt: z.string().datetime().optional(),
});

export async function createSchedule(input: z.infer<typeof ScheduleSchema>, actor: ArchiveActor) {
  await loadConnection(input.connectionId);
  const s = await prisma.salesforceBackupSchedule.create({
    data: { connectionId: input.connectionId, name: input.name, mids: input.mids, scope: { dataTypes: input.dataTypes } as Prisma.InputJsonValue, intervalHours: input.intervalHours, nextRunAt: input.firstRunAt ? new Date(input.firstRunAt) : new Date(Date.now() + input.intervalHours * 3_600_000), createdById: actor.id },
  });
  await archiveAudit({ actor, action: "archive.schedule.created", entityType: "salesforce_backup_schedule", entityId: s.id, metadata: { intervalHours: s.intervalHours, mids: s.mids } });
  return s;
}

export async function setScheduleEnabled(id: string, enabled: boolean, actor: ArchiveActor) {
  await prisma.salesforceBackupSchedule.update({ where: { id }, data: { enabled } });
  await archiveAudit({ actor, action: enabled ? "archive.schedule.enabled" : "archive.schedule.disabled", entityType: "salesforce_backup_schedule", entityId: id });
}

/** Called from the once-a-minute scheduler tick: due schedules + stalled jobs. */
export async function sfmcSchedulerTick() {
  const due = await prisma.salesforceBackupSchedule.findMany({ where: { enabled: true, nextRunAt: { lte: new Date() } }, take: 10 });
  for (const s of due) {
    // Claim the slot first so overlapping ticks cannot create two jobs.
    const claimed = await prisma.salesforceBackupSchedule.updateMany({ where: { id: s.id, nextRunAt: s.nextRunAt }, data: { nextRunAt: new Date(Date.now() + s.intervalHours * 3_600_000), lastRunAt: new Date() } });
    if (!claimed.count) continue;
    try {
      const job = await createBackupJob({ connectionId: s.connectionId, mids: s.mids, dataTypes: (s.scope as { dataTypes: string[] }).dataTypes, mode: "INCREMENTAL", refreshRecentDays: 14 }, null, { scheduleId: s.id });
      await prisma.salesforceBackupSchedule.update({ where: { id: s.id }, data: { lastJobId: job.id } });
    } catch (err) {
      await extractionLog({ level: "warn", message: `Scheduled backup "${s.name}" skipped: ${(err as Error).message}` });
    }
  }
  const stalled = await prisma.salesforceBackupJob.findMany({ where: { status: { in: ["QUEUED", "RUNNING", "CANCELLING"] }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }], updatedAt: { lt: new Date(Date.now() - 2 * 60_000) } }, take: 5 });
  for (const j of stalled) await resumeBackup(j.id, null);
}
