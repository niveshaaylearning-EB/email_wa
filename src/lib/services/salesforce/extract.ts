/**
 * Resumable dataset extraction.
 *
 * runDatasetSlice() fetches at most `maxPages` pages and returns, so a worker never holds a
 * long-running job and cancellation is honoured between pages. For each page:
 *   1. fetch (SOAP Retrieve / ContinueRequest, or REST page)
 *   2. store the raw payload encrypted in the archive store (SHA-256 recorded)
 *   3. in ONE transaction: page record + normalised rows + counters + next checkpoint
 * A crash between 2 and 3 leaves an orphan object but no DB state, and a replayed page is
 * idempotent thanks to the (dataset, page, row) keys.
 *
 * SOAP continuations can be consumed only once. If a continuation fails after it may have
 * reached Salesforce, the dataset restarts from page 1 under a new attempt number (earlier
 * attempt rows are discarded — the dataset is unsealed, so this is allowed) rather than
 * risking a silent gap. Restarts are capped.
 */
import "server-only";
import type { Prisma, SalesforceBackupDataset } from "@prisma/client";
import { prisma } from "@/lib/db";
import { maskDeep } from "@/lib/mask";
import { SfmcError, isSfmcError } from "@/lib/salesforce/errors";
import { unsupportedPropertiesFromError, SOAP_OBJECTS } from "@/lib/salesforce/objects";
import type { SfmcClient, RawRetrievePage } from "@/lib/salesforce/client";
import { putObject } from "@/lib/salesforce/storage";
import { clientFor, loadConnection, parseSettings } from "./connections";
import { normalizePage } from "./normalize";
import { runFilesSlice } from "./files";
import { extractionLog } from "./audit";
import type { DatasetCheckpoint, DatasetParams, SoapRequestSpec } from "./types";

export const MAX_RESTARTS = 3;
export const MAX_STEP_RETRIES = 6;
const TERMINAL = new Set(["EXTRACTED", "FAILED", "CANCELLED", "NOT_ACCESSIBLE", "NOT_RETRIEVABLE"]);

export type SliceOutcome = "continue" | "done" | "retry_later";

async function recordError(d: SalesforceBackupDataset, err: unknown, extra: { stage: string; pageNo?: number; attempt?: number }) {
  const e = isSfmcError(err) ? err : new SfmcError("request", err instanceof Error ? err.message : String(err));
  await prisma.salesforceExtractionError.create({
    data: {
      connectionId: d.connectionId,
      backupJobId: d.backupJobId,
      datasetId: d.id,
      mid: d.mid,
      objectType: e.details.objectType ?? d.objectType,
      stage: extra.stage,
      httpStatus: e.details.httpStatus ?? null,
      code: e.kind,
      message: String(maskDeep(e.message)).slice(0, 2000),
      retryable: e.retryable,
      attempt: extra.attempt ?? d.attempt,
      pageNo: extra.pageNo ?? null,
    },
  });
}

/** SOAP retrieve that drops properties the tenant rejects, recording each dropped property. */
async function retrieveWithFallback(client: SfmcClient, req: SoapRequestSpec, params: DatasetParams): Promise<RawRetrievePage> {
  for (let i = 0; i < 4; i++) {
    try {
      return await client.retrieve(req);
    } catch (err) {
      if (!isSfmcError(err) || err.kind !== "request") throw err;
      const bad = unsupportedPropertiesFromError(err.message).filter((p) => req.properties.includes(p));
      if (!bad.length || bad.length >= req.properties.length) throw err;
      req.properties = req.properties.filter((p) => !bad.includes(p));
      params.droppedProperties = { ...(params.droppedProperties ?? {}), [req.objectType]: [...(params.droppedProperties?.[req.objectType] ?? []), ...bad] };
    }
  }
  throw new SfmcError("request", `Retrieve of ${req.objectType} kept rejecting properties`);
}

/** Purge an unsealed dataset's partial attempt so it can restart cleanly. */
async function restartDataset(d: SalesforceBackupDataset, reason: string): Promise<SliceOutcome> {
  const cp = (d.checkpoint ?? {}) as DatasetCheckpoint;
  const restarts = (cp.restarts ?? 0) + 1;
  if (restarts > MAX_RESTARTS) {
    await prisma.salesforceBackupDataset.update({ where: { id: d.id }, data: { status: "FAILED", verificationStatus: "FAILED", errorMessage: `Gave up after ${MAX_RESTARTS} restarts: ${reason}`, finishedAt: new Date() } });
    await extractionLog({ backupJobId: d.backupJobId, datasetId: d.id, level: "error", message: `Dataset failed after ${MAX_RESTARTS} restarts`, data: { reason } });
    return "done";
  }
  await prisma.$transaction(async (tx) => {
    await tx.salesforceDataExtensionRow.deleteMany({ where: { datasetId: d.id } });
    await tx.salesforceTrackingEvent.deleteMany({ where: { datasetId: d.id } });
    await tx.salesforceSubscriber.deleteMany({ where: { datasetId: d.id } });
    await tx.salesforceBackupPage.deleteMany({ where: { datasetId: d.id } });
    await tx.salesforceBackupDataset.update({
      where: { id: d.id },
      data: { attempt: d.attempt + 1, pagesFetched: 0, recordsExtracted: 0, bytesStored: 0, checkpoint: { restarts } as Prisma.InputJsonValue, lastProgressAt: new Date() },
    });
  });
  await extractionLog({ backupJobId: d.backupJobId, datasetId: d.id, level: "warn", message: `Restarting dataset from page 1 (attempt ${d.attempt + 1})`, data: { reason } });
  return "continue";
}

async function appendFieldRequests(datasetId: string, params: DatasetParams, connectionId: string, mid: string) {
  const des = await prisma.salesforceDataExtension.findMany({ where: { connectionId, mid, inventoryDatasetId: datasetId }, select: { customerKey: true }, orderBy: { customerKey: "asc" } });
  const def = SOAP_OBJECTS.DataExtensionField;
  for (const de of des) {
    params.requests!.push({ objectType: def.objectType, properties: [...def.properties], filter: { property: "DataExtension.CustomerKey", operator: "equals", values: [de.customerKey] }, tag: de.customerKey });
  }
}

export async function runDatasetSlice(datasetId: string, maxPages: number): Promise<SliceOutcome> {
  let d = await prisma.salesforceBackupDataset.findUniqueOrThrow({ where: { id: datasetId } });
  if (TERMINAL.has(d.status)) return "done";
  const conn = await loadConnection(d.connectionId);
  const settings = parseSettings(conn.settings);
  const client = clientFor(conn, d.mid);
  if (d.status === "PENDING") {
    d = await prisma.salesforceBackupDataset.update({ where: { id: d.id }, data: { status: "RUNNING", startedAt: d.startedAt ?? new Date(), lastProgressAt: new Date() } });
    await extractionLog({ backupJobId: d.backupJobId, datasetId: d.id, level: "info", message: `Started ${d.label}`, data: { objectType: d.objectType, mid: d.mid } });
  }

  if ((d.params as unknown as DatasetParams).channel === "files") return runFilesSlice(d, client, maxPages * 5);

  for (let i = 0; i < maxPages; i++) {
    if (d.backupJobId) {
      const job = await prisma.salesforceBackupJob.findUnique({ where: { id: d.backupJobId }, select: { cancelRequestedAt: true } });
      if (job?.cancelRequestedAt) return "done"; // the runner finalises cancellation
    }
    const params = structuredClone(d.params) as unknown as DatasetParams;
    const cp = structuredClone(d.checkpoint ?? {}) as DatasetCheckpoint;
    const pageNo = cp.nextPage ?? 1;
    const callsBefore = client.apiCalls;
    const retriesBefore = client.retries;

    let results: Record<string, unknown>[];
    let raw: string;
    let ext: "xml" | "json";
    let overallStatus: string | null = null;
    let requestId: string | null = null;
    let moreData = false;
    let restTotal: number | null = null;
    try {
      if (params.channel === "soap") {
        const reqIndex = cp.reqIndex ?? 0;
        const req = params.requests![reqIndex];
        const page = cp.requestId ? await client.continueRetrieve(cp.requestId, req.objectType) : await retrieveWithFallback(client, req, params);
        results = page.results;
        raw = page.raw;
        ext = "xml";
        overallStatus = page.overallStatus;
        requestId = page.requestId;
        moreData = page.moreData;
        if (moreData && !requestId) throw new SfmcError("continuation", "MoreDataAvailable without a RequestID");
      } else {
        const rest = params.rest!;
        const restPage = cp.restPage ?? 1;
        const res = await client.rest<{ count?: number; items?: Record<string, unknown>[] }>("GET", rest.path, { query: { $page: restPage, [rest.pageSizeParam]: rest.pageSize, ...(rest.extraQuery ?? {}) } });
        results = res.json?.items ?? [];
        raw = res.text;
        ext = "json";
        restTotal = typeof res.json?.count === "number" ? res.json.count : null;
        const soFar = d.recordsExtracted + results.length;
        moreData = results.length > 0 && (restTotal === null ? results.length === rest.pageSize : soFar < restTotal);
        overallStatus = moreData ? "MorePages" : "OK";
      }
    } catch (err) {
      await recordError(d, err, { stage: params.channel === "soap" ? "retrieve" : "rest", pageNo });
      const e = isSfmcError(err) ? err : null;
      if (e?.kind === "permission" || (e?.kind === "auth" && pageNo === 1 && (d.pagesFetched ?? 0) === 0 && /not authorized|account_id/i.test(e.message))) {
        await prisma.salesforceBackupDataset.update({ where: { id: d.id }, data: { status: "NOT_ACCESSIBLE", verificationStatus: "NOT_ACCESSIBLE", errorMessage: e.message.slice(0, 1000), finishedAt: new Date(), apiCalls: { increment: client.apiCalls - callsBefore } } });
        await extractionLog({ backupJobId: d.backupJobId, datasetId: d.id, level: "warn", message: `Not accessible: ${d.label}`, data: { message: e.message } });
        return "done";
      }
      if (e?.kind === "continuation") return restartDataset(d, e.message);
      if (e?.retryable) {
        const stepRetries = (cp.stepRetries ?? 0) + 1;
        if (stepRetries > MAX_STEP_RETRIES) {
          await prisma.salesforceBackupDataset.update({ where: { id: d.id }, data: { status: "FAILED", verificationStatus: "FAILED", errorMessage: `Retries exhausted: ${e.message}`.slice(0, 1000), finishedAt: new Date() } });
          return "done";
        }
        await prisma.salesforceBackupDataset.update({ where: { id: d.id }, data: { checkpoint: { ...cp, stepRetries } as Prisma.InputJsonValue, retries: { increment: 1 }, apiCalls: { increment: client.apiCalls - callsBefore } } });
        await extractionLog({ backupJobId: d.backupJobId, datasetId: d.id, level: "warn", message: `Transient error, will retry (${stepRetries}/${MAX_STEP_RETRIES})`, data: { message: e.message } });
        return "retry_later";
      }
      await prisma.salesforceBackupDataset.update({ where: { id: d.id }, data: { status: "FAILED", verificationStatus: "FAILED", errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 1000), finishedAt: new Date() } });
      await extractionLog({ backupJobId: d.backupJobId, datasetId: d.id, level: "error", message: `Failed: ${d.label}`, data: { message: err instanceof Error ? err.message : String(err) } });
      return "done";
    }

    const stored = await putObject(`raw/${d.connectionId}/${d.mid}/${d.kind.toLowerCase()}/${d.id}/a${d.attempt}/p${String(pageNo).padStart(5, "0")}-${Date.now().toString(36)}.${ext}`, raw);

    // Next checkpoint
    const next: DatasetCheckpoint = { ...cp, nextPage: pageNo + 1, stepRetries: 0 };
    let done: boolean;
    if (params.channel === "soap") {
      const reqIndex = cp.reqIndex ?? 0;
      const rp = { ...(cp.requestPages ?? {}) };
      rp[reqIndex] = { pages: (rp[reqIndex]?.pages ?? 0) + 1, lastStatus: overallStatus };
      next.requestPages = rp;
      if (moreData) {
        next.reqIndex = reqIndex;
        next.requestId = requestId;
        done = false;
      } else {
        next.reqIndex = reqIndex + 1;
        next.requestId = null;
        done = next.reqIndex >= params.requests!.length;
      }
    } else {
      next.restPage = (cp.restPage ?? 1) + 1;
      next.restTotal = restTotal;
      done = !moreData;
    }

    d = await prisma.$transaction(
      async (tx) => {
        await tx.salesforceBackupPage.create({
          data: { datasetId: d.id, attempt: d.attempt, pageNo, recordCount: results.length, requestId, overallStatus, storageKey: stored.storageKey, sha256: stored.sha256, byteSize: stored.bytes },
        });
        await normalizePage({ tx, dataset: d, params, pageNo, requestIndex: cp.reqIndex ?? 0, sourceOffset: settings.sourceUtcOffset }, results);
        return tx.salesforceBackupDataset.update({
          where: { id: d.id },
          data: {
            pagesFetched: { increment: 1 },
            recordsExtracted: { increment: results.length },
            bytesStored: { increment: stored.bytes },
            apiCalls: { increment: client.apiCalls - callsBefore },
            retries: { increment: client.retries - retriesBefore },
            checkpoint: next as Prisma.InputJsonValue,
            params: params as unknown as Prisma.InputJsonValue,
            sourceCount: params.channel === "rest" && restTotal !== null ? restTotal : undefined,
            sourceCountMethod: params.channel === "rest" && restTotal !== null ? "REST response 'count' (source-reported total)" : undefined,
            lastProgressAt: new Date(),
          },
        });
      },
      { timeout: 120_000 },
    );

    // DataExtension list complete → queue one DataExtensionField request per DE.
    if (params.channel === "soap" && d.kind === "DE_INVENTORY" && !moreData && (cp.reqIndex ?? 0) === 0) {
      const p2 = structuredClone(d.params) as unknown as DatasetParams;
      await appendFieldRequests(d.id, p2, d.connectionId, d.mid);
      d = await prisma.salesforceBackupDataset.update({ where: { id: d.id }, data: { params: p2 as unknown as Prisma.InputJsonValue } });
      done = ((d.checkpoint as DatasetCheckpoint).reqIndex ?? 0) >= p2.requests!.length;
    }

    if (done) {
      d = await prisma.salesforceBackupDataset.update({ where: { id: d.id }, data: { status: "EXTRACTED", finishedAt: new Date() } });
      await extractionLog({ backupJobId: d.backupJobId, datasetId: d.id, level: "info", message: `Extracted ${d.label}: ${d.recordsExtracted} records in ${d.pagesFetched} pages`, data: { apiCalls: d.apiCalls } });
      return "done";
    }
  }
  return "continue";
}
