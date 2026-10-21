/**
 * Read-side queries for the Salesforce Archive screens. Every figure comes from archived,
 * extracted data — nothing is estimated. "Current" datasets are the latest non-superseded
 * extraction of each object.
 */
import "server-only";
import { Prisma, type SfTrackingEventType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { parseSettings } from "./connections";
import type { DatasetParams, VerificationCheck } from "./types";

const CURRENT = { supersededById: null } as const;
export const TRACKING_DATASET_KINDS = ["TRACKING_SENT", "TRACKING_OPEN", "TRACKING_CLICK", "TRACKING_BOUNCE", "TRACKING_UNSUB", "TRACKING_NOTSENT"] as const;

// ─── Overview ─────────────────────────────────────────────────────────

export async function archiveOverview() {
  const [connections, lastJobs, lastSuccess, byVerification, byStatus, deCount, jobCount, assetCount, journeyCount, automationCount, storage, recons, packages, errors7d, simulatedDatasets] = await Promise.all([
    prisma.salesforceConnection.findMany({ where: { archivedAt: null }, select: { id: true, name: true, kind: true, status: true, lastSuccessAt: true } }),
    prisma.salesforceBackupJob.findMany({ orderBy: { createdAt: "desc" }, take: 6 }),
    prisma.salesforceBackupJob.findFirst({ where: { status: { in: ["COMPLETED", "COMPLETED_WITH_GAPS"] } }, orderBy: { finishedAt: "desc" } }),
    prisma.salesforceBackupDataset.groupBy({ by: ["verificationStatus"], where: { ...CURRENT, kind: { not: "AUDIENCE_UPLOAD" } }, _count: true }),
    prisma.salesforceBackupDataset.groupBy({ by: ["kind"], where: { ...CURRENT, status: "EXTRACTED" }, _count: true, _sum: { recordsExtracted: true } }),
    prisma.salesforceDataExtension.count(),
    prisma.salesforceEmailJob.count(),
    prisma.salesforceAsset.count(),
    prisma.salesforceJourney.count(),
    prisma.salesforceAutomation.count(),
    prisma.salesforceBackupDataset.aggregate({ _sum: { bytesStored: true } }),
    prisma.salesforceReconciliationJob.count({ where: { status: "COMPLETED" } }),
    prisma.salesforceEvidencePackage.count(),
    prisma.salesforceExtractionError.count({ where: { createdAt: { gt: new Date(Date.now() - 7 * 86_400_000) } } }),
    prisma.salesforceBackupDataset.count({ where: { isSimulated: true } }),
  ]);
  // Record counts come from each current dataset's extraction counter, which the verification
  // engine checks against the rows actually stored (record_count check) — exact, and cheap.
  const sumKinds = (pred: (k: string) => boolean) => byStatus.filter((k) => pred(k.kind)).reduce((a, k) => a + (k._sum.recordsExtracted ?? 0), 0);
  const rowCount = sumKinds((k) => k === "DE_ROWS" || k === "AUDIENCE_UPLOAD");
  const eventCount = sumKinds((k) => k.startsWith("TRACKING_"));
  const subscriberCount = sumKinds((k) => k === "SUBSCRIBERS");
  return {
    connections,
    lastJobs,
    lastSuccess,
    verification: Object.fromEntries(byVerification.map((v) => [v.verificationStatus, v._count])) as Record<string, number>,
    byKind: byStatus.map((k) => ({ kind: k.kind, datasets: k._count, records: k._sum.recordsExtracted ?? 0 })),
    counts: { dataExtensions: deCount, deRows: rowCount, trackingEvents: eventCount, emailJobs: jobCount, subscribers: subscriberCount, assets: assetCount, journeys: journeyCount, automations: automationCount, reconciliations: recons, evidencePackages: packages },
    storageBytes: Number(storage._sum.bytesStored ?? 0),
    errors7d,
    hasSimulated: simulatedDatasets > 0,
  };
}

const aggregateCache = new Map<string, { key: string; value: unknown }>();
async function cachedByArchiveVersion<T>(name: string, compute: () => Promise<T>): Promise<T> {
  const [{ v }] = await prisma.$queryRaw<{ v: string | null }[]>`SELECT MAX(verified_at)::text || ':' || COUNT(*)::text AS v FROM salesforce_backup_datasets`;
  const hit = aggregateCache.get(name);
  if (hit && hit.key === v) return hit.value as T;
  const value = await compute();
  aggregateCache.set(name, { key: v ?? "", value });
  return value;
}

/** Tracking events per IST month for the overview chart (archived data only). */
export async function trackingByMonth() {
  return cachedByArchiveVersion("trackingByMonth", trackingByMonthUncached);
}
async function trackingByMonthUncached() {
  const rows = await prisma.$queryRaw<{ month: string; event_type: string; c: bigint }[]>`
    SELECT to_char(e.event_date AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month, e.event_type::text, COUNT(*) AS c
    FROM salesforce_tracking_events e JOIN salesforce_backup_datasets d ON d.id = e.dataset_id
    WHERE d.superseded_by_id IS NULL AND e.event_date IS NOT NULL
    GROUP BY 1, 2 ORDER BY 1`;
  const months = [...new Set(rows.map((r) => r.month))];
  return months.map((m) => {
    const o: Record<string, string | number> = { month: m };
    for (const r of rows.filter((x) => x.month === m)) o[r.event_type] = Number(r.c);
    return o;
  });
}

// ─── Coverage ─────────────────────────────────────────────────────────

/** Per event type: archived window, jobs covered, jobs not retrievable — never "0 events" for gaps. */
export async function trackingCoverage(mid?: string) {
  const conn = await prisma.salesforceConnection.findFirst({ where: { archivedAt: null }, orderBy: { createdAt: "asc" } });
  const settings = parseSettings(conn?.settings);
  const datasets = await prisma.salesforceBackupDataset.findMany({ where: { ...CURRENT, kind: { in: [...TRACKING_DATASET_KINDS] }, ...(mid ? { mid } : {}) }, select: { id: true, kind: true, status: true, sourceKey: true, verificationStatus: true, finishedAt: true } });
  const windows = await cachedByArchiveVersion(`windows:${mid ?? ""}`, () => prisma.$queryRaw<{ event_type: string; min: Date | null; max: Date | null }[]>`
    SELECT e.event_type::text, MIN(e.event_date) AS min, MAX(e.event_date) AS max FROM salesforce_tracking_events e
    JOIN salesforce_backup_datasets d ON d.id = e.dataset_id WHERE d.superseded_by_id IS NULL ${mid ? Prisma.sql`AND d.mid = ${mid}` : Prisma.empty} GROUP BY 1`);
  const jobs = await prisma.salesforceEmailJob.findMany({ where: mid ? { mid } : {}, select: { jobId: true, sendDate: true, sentDate: true } });
  const sendDates = jobs.map((j) => j.sentDate ?? j.sendDate).filter((d): d is Date => !!d);
  return {
    retention: settings.retention,
    sourceOffset: settings.sourceUtcOffset,
    emailJobsArchived: jobs.length,
    sendWindow: sendDates.length ? { from: new Date(Math.min(...sendDates.map((d) => d.getTime()))), to: new Date(Math.max(...sendDates.map((d) => d.getTime()))) } : null,
    byType: TRACKING_DATASET_KINDS.map((k) => {
      const ds = datasets.filter((d) => d.kind === k);
      const w = windows.find((x) => x.event_type === k.replace("TRACKING_", ""));
      return {
        kind: k,
        eventType: k.replace("TRACKING_", "") as SfTrackingEventType,
        jobsExtracted: ds.filter((d) => d.status === "EXTRACTED").length,
        jobsNotRetrievable: ds.filter((d) => d.status === "NOT_RETRIEVABLE").length,
        jobsNotAccessible: ds.filter((d) => d.status === "NOT_ACCESSIBLE").length,
        jobsFailed: ds.filter((d) => d.status === "FAILED").length,
        jobsNotArchived: Math.max(0, jobs.length - ds.length),
        verified: ds.filter((d) => d.verificationStatus === "VERIFIED").length,
        observedFrom: w?.min ?? null,
        observedTo: w?.max ?? null,
      };
    }),
  };
}


// ─── Backups ──────────────────────────────────────────────────────────

export async function listBackupJobs(page = 1, pageSize = 25) {
  const [total, rows] = await Promise.all([prisma.salesforceBackupJob.count(), prisma.salesforceBackupJob.findMany({ orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize, include: { connection: { select: { name: true, kind: true } } } })]);
  return { total, rows };
}

export async function getBackupJob(id: string) {
  const job = await prisma.salesforceBackupJob.findUnique({ where: { id }, include: { connection: { select: { id: true, name: true, kind: true } }, datasets: { orderBy: { createdAt: "asc" } } } });
  if (!job) throw notFound("Backup job");
  const [errors, manifests, logs] = await Promise.all([
    prisma.salesforceExtractionError.findMany({ where: { backupJobId: id }, orderBy: { createdAt: "desc" }, take: 100 }),
    prisma.salesforceBackupManifest.findMany({ where: { backupJobId: id, scope: "JOB" }, orderBy: { version: "desc" } }),
    prisma.salesforceExtractionLog.findMany({ where: { backupJobId: id }, orderBy: { createdAt: "desc" }, take: 60 }),
  ]);
  return { job, errors, manifests, logs };
}

export async function listSchedules() {
  return prisma.salesforceBackupSchedule.findMany({ orderBy: { createdAt: "asc" }, include: { connection: { select: { name: true } } } });
}

// ─── Data Extensions ──────────────────────────────────────────────────

export async function listDataExtensions(opts: { q?: string; mid?: string; page: number; pageSize: number }) {
  const where: Prisma.SalesforceDataExtensionWhereInput = {
    ...(opts.mid ? { mid: opts.mid } : {}),
    ...(opts.q ? { OR: [{ name: { contains: opts.q, mode: "insensitive" } }, { customerKey: { contains: opts.q, mode: "insensitive" } }, { folderPath: { contains: opts.q, mode: "insensitive" } }] } : {}),
  };
  const [total, rows] = await Promise.all([prisma.salesforceDataExtension.count({ where }), prisma.salesforceDataExtension.findMany({ where, orderBy: { name: "asc" }, skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize, include: { _count: { select: { fields: true } } } })]);
  const latestIds = rows.map((r) => r.latestRowsDatasetId).filter((x): x is string => !!x);
  const datasets = await prisma.salesforceBackupDataset.findMany({ where: { id: { in: latestIds } }, select: { id: true, recordsExtracted: true, verificationStatus: true, finishedAt: true } });
  // DEs whose most recent rows extraction failed / was not accessible
  const lastAttempts = await prisma.salesforceBackupDataset.findMany({ where: { kind: "DE_ROWS", sourceKey: { in: rows.map((r) => r.customerKey) }, ...CURRENT }, orderBy: { createdAt: "desc" }, select: { sourceKey: true, mid: true, status: true, verificationStatus: true } });
  return {
    total,
    rows: rows.map((r) => ({
      ...r,
      rows: datasets.find((d) => d.id === r.latestRowsDatasetId) ?? null,
      lastAttempt: lastAttempts.find((a) => a.sourceKey === r.customerKey && a.mid === r.mid) ?? null,
    })),
  };
}

export async function getDataExtension(id: string) {
  const de = await prisma.salesforceDataExtension.findUnique({ where: { id }, include: { fields: { orderBy: [{ ordinal: "asc" }, { name: "asc" }] } } });
  if (!de) throw notFound("Data Extension");
  const datasets = await prisma.salesforceBackupDataset.findMany({ where: { kind: "DE_ROWS", connectionId: de.connectionId, mid: de.mid, sourceKey: de.customerKey }, orderBy: { createdAt: "desc" }, include: { backupJob: { select: { code: true } } } });
  return { de, datasets };
}

export async function searchDatasetRows(datasetId: string, opts: { q?: string; page: number; pageSize: number }) {
  const where: Prisma.SalesforceDataExtensionRowWhereInput = { datasetId };
  if (opts.q) {
    // Exact value match on any field (JSONB containment cannot do partial matches), or PK prefix.
    const ids = await prisma.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM salesforce_data_extension_rows WHERE dataset_id = ${datasetId}
      AND (primary_key ILIKE ${opts.q + "%"} OR EXISTS (SELECT 1 FROM jsonb_each_text(values) kv WHERE kv.value ILIKE ${"%" + opts.q + "%"}))
      ORDER BY id LIMIT 5000`;
    where.id = { in: ids.map((i) => i.id) };
  }
  const [total, rows] = await Promise.all([prisma.salesforceDataExtensionRow.count({ where }), prisma.salesforceDataExtensionRow.findMany({ where, orderBy: { id: "asc" }, skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize })]);
  return { total, rows, capped: !!opts.q && total >= 5000 };
}

// ─── Email campaigns ──────────────────────────────────────────────────

/**
 * Per-send status of the archived email body:
 *   exact   — archived content not modified after this send (what was sent)
 *   edited  — archived content, but the email was modified after this send (may differ)
 *   missing — no archived content (deleted from Content Builder, or not archived yet)
 */
export type ContentStatus = "exact" | "edited" | "missing";
const CONTENT_STATUS_SQL = Prisma.sql`
  SELECT j.id,
    CASE
      WHEN e.html_storage_key IS NOT NULL OR e.text_storage_key IS NOT NULL THEN
        CASE WHEN e.modified_at > COALESCE(j.sent_date, j.send_date) THEN 'edited' ELSE 'exact' END
      WHEN a.content_storage_key IS NOT NULL THEN
        CASE WHEN a.modified_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*[+-][0-9]{2}:[0-9]{2}$' AND a.modified_date::timestamptz > COALESCE(j.sent_date, j.send_date) THEN 'edited' ELSE 'exact' END
      ELSE 'missing'
    END AS status
  FROM salesforce_email_jobs j
  LEFT JOIN salesforce_emails e ON e.connection_id = j.connection_id AND e.mid = j.mid AND e.email_id = j.email_id
  LEFT JOIN LATERAL (
    SELECT content_storage_key, modified_date FROM salesforce_assets x
    WHERE x.connection_id = j.connection_id AND x.mid = j.mid AND x.legacy_id = j.email_id
    LIMIT 1
  ) a ON true`;

export async function contentStatusCounts() {
  const rows = await prisma.$queryRaw<{ status: ContentStatus; n: number }[]>`SELECT status, COUNT(*)::int AS n FROM (${CONTENT_STATUS_SQL}) s GROUP BY status`;
  return Object.fromEntries(rows.map((r) => [r.status, r.n])) as Partial<Record<ContentStatus, number>>;
}

export async function listEmailJobs(opts: { q?: string; mid?: string; from?: Date; to?: Date; content?: ContentStatus; page: number; pageSize: number }) {
  const contentIds = opts.content ? (await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM (${CONTENT_STATUS_SQL}) s WHERE status = ${opts.content}`).map((r) => r.id) : null;
  const where: Prisma.SalesforceEmailJobWhereInput = {
    ...(contentIds ? { id: { in: contentIds } } : {}),
    ...(opts.mid ? { mid: opts.mid } : {}),
    ...(opts.from || opts.to ? { sendDate: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } } : {}),
    ...(opts.q
      ? { OR: [{ jobId: { equals: opts.q.trim() } }, { emailId: { equals: opts.q.trim() } }, { subject: { contains: opts.q, mode: "insensitive" } }, { emailName: { contains: opts.q, mode: "insensitive" } }] }
      : {}),
  };
  const [total, rows] = await Promise.all([prisma.salesforceEmailJob.count({ where }), prisma.salesforceEmailJob.findMany({ where, orderBy: [{ sendDate: "desc" }, { jobId: "desc" }], skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize })]);
  const ids = rows.map((r) => r.id);
  const statuses = ids.length ? await prisma.$queryRaw<{ id: string; status: ContentStatus }[]>`SELECT id, status FROM (${CONTENT_STATUS_SQL}) s WHERE id = ANY(${ids}::text[])` : [];
  const trk = await prisma.salesforceBackupDataset.findMany({ where: { ...CURRENT, kind: { in: [...TRACKING_DATASET_KINDS] }, sourceKey: { in: rows.map((r) => r.jobId) } }, select: { kind: true, sourceKey: true, mid: true, status: true, verificationStatus: true, recordsExtracted: true } });
  return {
    total,
    rows: rows.map((r) => ({ ...r, contentStatus: (statuses.find((x) => x.id === r.id)?.status ?? "missing") as ContentStatus, tracking: trk.filter((t) => t.sourceKey === r.jobId && t.mid === r.mid) })),
  };
}

export async function getEmailJob(mid: string, jobId: string) {
  const job = await prisma.salesforceEmailJob.findFirst({ where: { mid, jobId } });
  if (!job) throw notFound("Email job");
  const tracking = await prisma.salesforceBackupDataset.findMany({ where: { mid, sourceKey: jobId, kind: { in: [...TRACKING_DATASET_KINDS] } }, orderBy: { createdAt: "desc" } });
  const current = tracking.filter((t) => !t.supersededById);
  const extractedIds = current.filter((t) => t.status === "EXTRACTED").map((t) => t.id);
  const stats = extractedIds.length
    ? await prisma.$queryRaw<{ event_type: string; rows: bigint; events: bigint; subs: bigint }[]>`
        SELECT event_type::text, COUNT(*) AS rows, COUNT(DISTINCT fingerprint) AS events, COUNT(DISTINCT subscriber_key) AS subs
        FROM salesforce_tracking_events WHERE dataset_id = ANY(${extractedIds}::text[]) GROUP BY 1`
    : [];
  const asset = job.emailId ? await prisma.salesforceAsset.findFirst({ where: { mid, assetId: job.emailId }, select: { id: true, name: true } }) : null;
  const recons = await prisma.salesforceReconciliationJob.findMany({ where: { mid, jobIds: { has: jobId } }, orderBy: { createdAt: "desc" }, select: { id: true, code: true, name: true, status: true, createdAt: true } });
  const clicksByUrl = extractedIds.length
    ? await prisma.$queryRaw<{ url: string | null; c: bigint }[]>`SELECT url, COUNT(DISTINCT fingerprint) AS c FROM salesforce_tracking_events WHERE dataset_id = ANY(${extractedIds}::text[]) AND event_type = 'CLICK' GROUP BY url ORDER BY c DESC LIMIT 10`
    : [];
  return { job, tracking, current, stats: stats.map((s) => ({ eventType: s.event_type, rows: Number(s.rows), events: Number(s.events), subscribers: Number(s.subs) })), asset, recons, clicksByUrl: clicksByUrl.map((c) => ({ url: c.url ?? "(none)", count: Number(c.c) })) };
}

// ─── Recipient tracking ───────────────────────────────────────────────

/** Ids of current, extracted tracking datasets — restricted to `candidates` when given (keeps queries small). */
async function currentTrackingDatasetIds(filter: { mid?: string; jobId?: string; candidates?: string[] }) {
  return (
    await prisma.salesforceBackupDataset.findMany({
      where: { ...CURRENT, status: "EXTRACTED", kind: { in: [...TRACKING_DATASET_KINDS] }, ...(filter.mid ? { mid: filter.mid } : {}), ...(filter.jobId ? { sourceKey: filter.jobId } : {}), ...(filter.candidates ? { id: { in: filter.candidates } } : {}) },
      select: { id: true },
    })
  ).map((d) => d.id);
}

async function datasetsHoldingSubscriber(subscriberKey: string) {
  return (await prisma.salesforceTrackingEvent.groupBy({ by: ["datasetId"], where: { subscriberKey } })).map((g) => g.datasetId);
}

export async function searchTracking(opts: { subscriberKey?: string; jobId?: string; eventType?: SfTrackingEventType; mid?: string; from?: Date; to?: Date; page: number; pageSize: number }) {
  const datasetIds = await currentTrackingDatasetIds({ mid: opts.mid, jobId: opts.jobId, candidates: opts.subscriberKey ? await datasetsHoldingSubscriber(opts.subscriberKey) : undefined });
  const where: Prisma.SalesforceTrackingEventWhereInput = {
    datasetId: { in: datasetIds },
    ...(opts.subscriberKey ? { subscriberKey: opts.subscriberKey } : {}),
    ...(opts.eventType ? { eventType: opts.eventType } : {}),
    ...(opts.from || opts.to ? { eventDate: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } } : {}),
  };
  const [total, rows] = await Promise.all([prisma.salesforceTrackingEvent.count({ where }), prisma.salesforceTrackingEvent.findMany({ where, orderBy: [{ eventDate: "desc" }, { id: "desc" }], skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize, omit: { raw: true } })]);
  return { total, rows };
}

export interface TimelineJob {
  jobId: string;
  mid: string;
  emailName: string | null;
  subject: string | null;
  sendDate: Date | null;
  states: Record<string, { status: "OBSERVED" | "NOT_OBSERVED" | "NOT_RETRIEVABLE" | "NOT_ACCESSIBLE" | "NOT_ARCHIVED"; events: { date: Date | null; raw: string | null; detail: string | null }[] }>;
}

/** Field names used for the subscriber identity across archived DEs (case/spacing variants). */
async function identityFieldNames(): Promise<string[]> {
  return cachedByArchiveVersion("identityFieldNames", async () =>
    (
      await prisma.$queryRaw<{ name: string }[]>`
        SELECT DISTINCT name FROM salesforce_data_extension_fields
        WHERE lower(regexp_replace(name, '[[:space:]_]', '', 'g')) IN ('subscriberkey', 'contactkey', 'contectkey')`
    ).map((r) => r.name),
  );
}

/** Everything the archive knows about one subscriber, per job, with explicit unknown states. */
export async function subscriberTimeline(subscriberKey: string, mid?: string) {
  const current = await currentTrackingDatasetIds({ mid, candidates: await datasetsHoldingSubscriber(subscriberKey) });
  const events = await prisma.salesforceTrackingEvent.findMany({ where: { subscriberKey, datasetId: { in: current } }, orderBy: { eventDate: "asc" }, omit: { raw: true } });
  const jobIds = [...new Set(events.map((e) => e.jobId).filter((j): j is string => !!j))];
  const jobs = await prisma.salesforceEmailJob.findMany({ where: { jobId: { in: jobIds }, ...(mid ? { mid } : {}) } });
  const datasets = await prisma.salesforceBackupDataset.findMany({ where: { ...CURRENT, kind: { in: [...TRACKING_DATASET_KINDS] }, sourceKey: { in: jobIds } }, select: { kind: true, sourceKey: true, status: true } });
  const timeline: TimelineJob[] = jobIds.map((jobId) => {
    const j = jobs.find((x) => x.jobId === jobId);
    const states: TimelineJob["states"] = {};
    for (const k of TRACKING_DATASET_KINDS) {
      const t = k.replace("TRACKING_", "");
      const ev = events.filter((e) => e.jobId === jobId && e.eventType === t);
      const ds = datasets.find((d) => d.sourceKey === jobId && d.kind === k);
      const status = ev.length ? "OBSERVED" : !ds ? "NOT_ARCHIVED" : ds.status === "NOT_RETRIEVABLE" ? "NOT_RETRIEVABLE" : ds.status === "NOT_ACCESSIBLE" ? "NOT_ACCESSIBLE" : ds.status === "EXTRACTED" ? "NOT_OBSERVED" : "NOT_ARCHIVED";
      states[t] = { status, events: ev.map((e) => ({ date: e.eventDate, raw: e.eventDateRaw, detail: e.url ?? e.bounceCategory ?? e.sourceEventType ?? null })) };
    }
    return { jobId, mid: j?.mid ?? events.find((e) => e.jobId === jobId)!.mid, emailName: j?.emailName ?? null, subject: j?.subject ?? null, sendDate: j?.sentDate ?? j?.sendDate ?? null, states };
  });
  timeline.sort((a, b) => (b.sendDate?.getTime() ?? 0) - (a.sendDate?.getTime() ?? 0));
  // Audience membership: DE snapshots containing this subscriber (state at extraction time).
  // Lists name the identity column differently (SubscriberKey, ContactKey, "Contect Key", …);
  // one JSONB containment test per spelling lets the GIN index answer the lookup.
  const idFields = await identityFieldNames();
  const conditions = idFields.map((f) => Prisma.sql`r.values @> ${JSON.stringify({ [f]: subscriberKey })}::jsonb`);
  const hits = conditions.length
    ? await prisma.$queryRaw<{ dataset_id: string; c: bigint }[]>`SELECT r.dataset_id, COUNT(*) AS c FROM salesforce_data_extension_rows r WHERE ${Prisma.join(conditions, " OR ")} GROUP BY 1`
    : [];
  const hitDatasets = await prisma.salesforceBackupDataset.findMany({ where: { id: { in: hits.map((h) => h.dataset_id) }, supersededById: null, kind: { in: ["DE_ROWS", "AUDIENCE_UPLOAD"] } }, select: { id: true, label: true, finishedAt: true }, orderBy: { finishedAt: "desc" } });
  const memberships = hitDatasets.map((d) => ({ dataset_id: d.id, label: d.label, finished_at: d.finishedAt, c: hits.find((h) => h.dataset_id === d.id)!.c }));
  const subscriber = await prisma.salesforceSubscriber.findFirst({ where: { subscriberKey, ...(mid ? { mid } : {}) }, orderBy: { id: "desc" } });
  return { timeline, memberships: memberships.map((m) => ({ datasetId: m.dataset_id, label: m.label, extractedAt: m.finished_at, rows: Number(m.c) })), subscriber, eventCount: events.length };
}

// ─── Journeys / automations / content ────────────────────────────────

export async function listJourneys(q?: string) {
  return prisma.salesforceJourney.findMany({ where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { key: { contains: q, mode: "insensitive" } }] } : {}, orderBy: [{ name: "asc" }, { version: "desc" }], omit: { raw: true } });
}
export async function listAutomations(q?: string) {
  return prisma.salesforceAutomation.findMany({ where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { customerKey: { contains: q, mode: "insensitive" } }] } : {}, orderBy: [{ kind: "asc" }, { name: "asc" }] });
}
export async function listAssets(opts: { q?: string; type?: string; page: number; pageSize: number }) {
  const where: Prisma.SalesforceAssetWhereInput = {
    ...(opts.type ? { assetType: opts.type } : {}),
    ...(opts.q ? { OR: [{ name: { contains: opts.q, mode: "insensitive" } }, { subject: { contains: opts.q, mode: "insensitive" } }, { assetId: opts.q.trim() }] } : {}),
  };
  const [total, rows, types] = await Promise.all([
    prisma.salesforceAsset.count({ where }),
    prisma.salesforceAsset.findMany({ where, orderBy: { modifiedDate: "desc" }, skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize, omit: { raw: true } }),
    prisma.salesforceAsset.groupBy({ by: ["assetType"], _count: true }),
  ]);
  return { total, rows, types: types.map((t) => ({ type: t.assetType, count: t._count })) };
}

// ─── Verification / logs ──────────────────────────────────────────────

export async function verificationBoard(filter?: { status?: string; kind?: string }, page = 1, pageSize = 100) {
  const where: Prisma.SalesforceBackupDatasetWhereInput = { ...CURRENT, ...(filter?.status ? { verificationStatus: filter.status as never } : {}), ...(filter?.kind ? { kind: filter.kind as never } : {}) };
  const [total, rows] = await Promise.all([
    prisma.salesforceBackupDataset.count({ where }),
    prisma.salesforceBackupDataset.findMany({ where, orderBy: [{ verificationStatus: "asc" }, { createdAt: "desc" }], skip: (page - 1) * pageSize, take: pageSize, include: { backupJob: { select: { code: true } } } }),
  ]);
  return { total, rows: rows.map((d) => ({ ...d, checks: ((d.verificationDetails as { checks?: VerificationCheck[] }).checks ?? []) as VerificationCheck[], datasetParams: d.params as unknown as DatasetParams })) };
}

/** Exact counts over ALL current datasets, by verification status and by kind. */
export async function verificationCounts() {
  const [byStatus, byKind] = await Promise.all([
    prisma.salesforceBackupDataset.groupBy({ by: ["verificationStatus"], where: CURRENT, _count: true }),
    prisma.salesforceBackupDataset.groupBy({ by: ["kind"], where: CURRENT, _count: true }),
  ]);
  return { byStatus: Object.fromEntries(byStatus.map((s) => [s.verificationStatus, s._count])) as Record<string, number>, kinds: byKind.map((k) => k.kind) };
}

export async function listExtractionLogs(opts: { level?: string; q?: string; backupJobId?: string; page: number; pageSize: number }) {
  const where: Prisma.SalesforceExtractionLogWhereInput = { ...(opts.level ? { level: opts.level } : {}), ...(opts.backupJobId ? { backupJobId: opts.backupJobId } : {}), ...(opts.q ? { message: { contains: opts.q, mode: "insensitive" } } : {}) };
  const [total, rows] = await Promise.all([prisma.salesforceExtractionLog.count({ where }), prisma.salesforceExtractionLog.findMany({ where, orderBy: { id: "desc" }, skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize })]);
  return { total, rows };
}

export async function listExtractionErrors(limit = 100) {
  return prisma.salesforceExtractionError.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}

export async function listArchiveAudit(opts: { q?: string; page: number; pageSize: number }) {
  const where: Prisma.SalesforceArchiveAuditLogWhereInput = opts.q ? { OR: [{ action: { contains: opts.q, mode: "insensitive" } }, { actorEmail: { contains: opts.q, mode: "insensitive" } }, { entityId: opts.q }] } : {};
  const [total, rows] = await Promise.all([prisma.salesforceArchiveAuditLog.count({ where }), prisma.salesforceArchiveAuditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize })]);
  return { total, rows };
}

// ─── Audit center ─────────────────────────────────────────────────────

export async function listReconciliations() {
  return prisma.salesforceReconciliationJob.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
}
export async function getReconciliation(id: string) {
  const rec = await prisma.salesforceReconciliationJob.findUnique({ where: { id } });
  if (!rec) throw notFound("Reconciliation");
  const [audience, packages] = await Promise.all([prisma.salesforceBackupDataset.findUnique({ where: { id: rec.audienceDatasetId } }), prisma.salesforceEvidencePackage.findMany({ where: { kind: "RECONCILIATION", params: { path: ["reconciliationId"], equals: id } }, orderBy: { createdAt: "desc" } })]);
  return { rec, audience, packages };
}
export async function reconciliationResults(id: string, opts: { classification?: string; q?: string; page: number; pageSize: number }) {
  const where: Prisma.SalesforceReconciliationResultWhereInput = { reconciliationId: id, ...(opts.classification ? { classification: opts.classification as never } : {}), ...(opts.q ? { OR: [{ identity: { contains: opts.q, mode: "insensitive" } }, { rawIdentity: { contains: opts.q, mode: "insensitive" } }] } : {}) };
  const [total, rows] = await Promise.all([prisma.salesforceReconciliationResult.count({ where }), prisma.salesforceReconciliationResult.findMany({ where, orderBy: { id: "asc" }, skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize })]);
  return { total, rows };
}
export async function listEvidencePackages() {
  return prisma.salesforceEvidencePackage.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
}
export async function audienceCandidates() {
  return prisma.salesforceBackupDataset.findMany({
    where: { kind: { in: ["DE_ROWS", "AUDIENCE_UPLOAD"] }, status: "EXTRACTED", sealedAt: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: { id: true, kind: true, label: true, mid: true, sourceKey: true, recordsExtracted: true, finishedAt: true, params: true, supersededById: true, verificationStatus: true, isSimulated: true },
  });
}
