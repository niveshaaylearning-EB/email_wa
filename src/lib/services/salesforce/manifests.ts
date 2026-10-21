/**
 * Backup manifests. Each manifest is canonical JSON (sorted keys), hashed with SHA-256,
 * stored in the archive store and in salesforce_backup_manifests (append-only). Manifests
 * of one backup job form a hash chain via previousSha256, so a removed or altered manifest
 * is detectable. Manifests never contain credentials or tokens.
 */
import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { stableStringify } from "@/lib/crypto";
import { putObject, sha256Hex } from "@/lib/salesforce/storage";
import type { DatasetParams } from "./types";

export const MANIFEST_VERSION = 1;

async function chainHead(backupJobId: string | null): Promise<string | null> {
  if (!backupJobId) return null;
  // The head is the manifest no other manifest of this job points to.
  const all = await prisma.salesforceBackupManifest.findMany({ where: { backupJobId }, select: { sha256: true, previousSha256: true } });
  const referenced = new Set(all.map((m) => m.previousSha256));
  return all.find((m) => !referenced.has(m.sha256))?.sha256 ?? null;
}

// Datasets of one backup are verified concurrently; appending to a job's hash chain must be
// serialised so every manifest links to exactly one predecessor. (One process runs a backup
// at a time — the job lease guarantees it — so an in-process lock is sufficient.)
const chainLocks = new Map<string, Promise<unknown>>();
function withChainLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chainLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  chainLocks.set(key, tail);
  void tail.then(() => {
    if (chainLocks.get(key) === tail) chainLocks.delete(key);
  });
  return run;
}

function persist(scope: "DATASET" | "JOB", body: Record<string, unknown>, ids: { backupJobId: string | null; datasetId: string | null }, keyBase: string) {
  return withChainLock(ids.backupJobId ?? `standalone:${ids.datasetId}`, () => persistUnlocked(scope, body, ids, keyBase));
}

async function persistUnlocked(scope: "DATASET" | "JOB", body: Record<string, unknown>, ids: { backupJobId: string | null; datasetId: string | null }, keyBase: string) {
  const previousSha256 = await chainHead(ids.backupJobId);
  const version = (await prisma.salesforceBackupManifest.count({ where: scope === "DATASET" ? { datasetId: ids.datasetId } : { backupJobId: ids.backupJobId, scope: "JOB" } })) + 1;
  const manifest = { ...body, manifestScope: scope, manifestRevision: version, previousManifestSha256: previousSha256 };
  const canonical = stableStringify(manifest);
  const sha256 = sha256Hex(canonical);
  const stored = await putObject(`manifests/${keyBase}-r${version}-${sha256.slice(0, 12)}.json`, canonical, { gzip: false });
  return prisma.salesforceBackupManifest.create({
    data: { scope, backupJobId: ids.backupJobId, datasetId: ids.datasetId, version, manifest: manifest as Prisma.InputJsonValue, sha256, previousSha256, storageKey: stored.storageKey },
  });
}

export async function writeDatasetManifest(datasetId: string) {
  const d = await prisma.salesforceBackupDataset.findUniqueOrThrow({ where: { id: datasetId }, include: { backupJob: { select: { code: true } } } });
  const conn = await prisma.salesforceConnection.findUnique({ where: { id: d.connectionId }, select: { id: true, name: true, kind: true, authBaseUri: true } });
  const pages = await prisma.salesforceBackupPage.findMany({ where: { datasetId }, orderBy: { pageNo: "asc" } });
  const params = d.params as unknown as DatasetParams;
  const body = {
    manifestVersion: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    simulated: d.isSimulated,
    dataset: { id: d.id, kind: d.kind, label: d.label, objectType: d.objectType, sourceKey: d.sourceKey, status: d.status },
    backupJob: d.backupJobId ? { id: d.backupJobId, code: d.backupJob?.code ?? null } : null,
    source: { system: "Salesforce Marketing Cloud Engagement", connectionId: conn?.id, connectionName: conn?.name, connectionKind: conn?.kind, authHost: conn?.authBaseUri ? new URL(conn.authBaseUri).host : null, mid: d.mid },
    request: {
      channel: params.channel,
      requests: params.requests?.map((r) => ({ objectType: r.objectType, properties: r.properties, filter: r.filter ?? null, queryAllAccounts: !!r.queryAllAccounts, tag: r.tag ?? null })) ?? null,
      rest: params.rest ?? null,
      droppedProperties: params.droppedProperties ?? {},
      pageLimit: params.pageLimit,
      window: params.window ?? null,
      jobId: params.jobId ?? null,
      sourceTimezoneOffsetAssumed: params.sourceTimezoneOffset ?? null,
    },
    schema: params.schema ?? null,
    upload: params.upload ?? null,
    extraction: {
      attempt: d.attempt,
      startedAt: d.startedAt?.toISOString() ?? null,
      finishedAt: d.finishedAt?.toISOString() ?? null,
      apiCalls: d.apiCalls,
      retries: d.retries,
      pages: pages.map((p) => ({ pageNo: p.pageNo, records: p.recordCount, sha256: p.sha256, bytes: p.byteSize, storageKey: p.storageKey, requestId: p.requestId, overallStatus: p.overallStatus, fetchedAt: p.fetchedAt.toISOString() })),
    },
    records: d.recordsExtracted,
    sourceCount: d.sourceCount,
    sourceCountMethod: d.sourceCountMethod,
    verification: { status: d.verificationStatus, verifiedAt: d.verifiedAt?.toISOString() ?? null, details: d.verificationDetails },
    sealedAt: d.sealedAt?.toISOString() ?? null,
  };
  return persist("DATASET", body, { backupJobId: d.backupJobId, datasetId: d.id }, `${d.backupJobId ?? "standalone"}/${d.id}`);
}

export async function writeJobManifest(backupJobId: string) {
  const job = await prisma.salesforceBackupJob.findUniqueOrThrow({ where: { id: backupJobId } });
  const datasets = await prisma.salesforceBackupDataset.findMany({ where: { backupJobId }, orderBy: { createdAt: "asc" } });
  const latest = await prisma.salesforceBackupManifest.findMany({ where: { backupJobId, scope: "DATASET" }, orderBy: { version: "desc" }, distinct: ["datasetId"] });
  const byDataset = new Map(latest.map((m) => [m.datasetId, m.sha256]));
  const body = {
    manifestVersion: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    simulated: job.isSimulated,
    backupJob: { id: job.id, code: job.code, mode: job.mode, mids: job.mids, scope: job.scope, status: job.status, createdByEmail: job.createdByEmail, startedAt: job.startedAt?.toISOString() ?? null, finishedAt: job.finishedAt?.toISOString() ?? null },
    verification: { status: job.verificationStatus, notes: job.verificationNotes },
    stats: job.stats,
    datasets: datasets.map((d) => ({ id: d.id, kind: d.kind, label: d.label, mid: d.mid, status: d.status, verificationStatus: d.verificationStatus, records: d.recordsExtracted, pages: d.pagesFetched, manifestSha256: byDataset.get(d.id) ?? null })),
  };
  return persist("JOB", body, { backupJobId, datasetId: null }, `${backupJobId}/job`);
}

/** Recompute every manifest hash in a job's chain and confirm the links. */
export async function verifyManifestChain(backupJobId: string) {
  const all = await prisma.salesforceBackupManifest.findMany({ where: { backupJobId } });
  const problems: string[] = [];
  for (const m of all) if (sha256Hex(stableStringify(m.manifest)) !== m.sha256) problems.push(`manifest ${m.id}: content hash mismatch`);
  // Follow the links from the genesis manifest; every manifest must be on one unbroken chain.
  const byPrev = new Map<string | null, typeof all>();
  for (const m of all) byPrev.set(m.previousSha256, [...(byPrev.get(m.previousSha256) ?? []), m]);
  for (const [prev, ms] of byPrev) if (ms.length > 1) problems.push(`chain fork: ${ms.length} manifests link to ${prev ?? "genesis"}`);
  let cur: string | null = null;
  let walked = 0;
  for (;;) {
    const nextM: (typeof all)[number] | undefined = byPrev.get(cur)?.[0];
    if (!nextM) break;
    walked += 1;
    cur = nextM.sha256;
    if (walked > all.length) break;
  }
  if (walked !== all.length) problems.push(`chain broken: ${walked} of ${all.length} manifests reachable from genesis`);
  return { ok: problems.length === 0, count: all.length, problems };
}
