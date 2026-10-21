/**
 * Backup verification engine.
 *
 * A dataset is never "complete" just because pagination ended. Status rules:
 *   FAILED             any integrity check failed (gap, hash mismatch, count disagreement, …)
 *   NOT_ACCESSIBLE     the API user could not read the object
 *   NOT_RETRIEVABLE    the source returned nothing for a period outside its retention window
 *   VERIFIED           every integrity check passed AND an independent source count matched
 *   PARTIALLY_VERIFIED integrity passed but no independent count exists ("limited"), or a
 *                      non-fatal anomaly (warning) was found
 *   UNVERIFIED         not yet checked / extraction incomplete
 */
import "server-only";
import type { Prisma, SalesforceBackupDataset, SfVerificationStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { verifyObject } from "@/lib/salesforce/storage";
import { TRACKING_KIND_TO_EVENT } from "@/lib/salesforce/objects";
import { parseSettings } from "./connections";
import { writeDatasetManifest } from "./manifests";
import { extractionLog } from "./audit";
import type { DatasetCheckpoint, DatasetParams, VerificationCheck } from "./types";

const RECORD_TABLE_KINDS = new Set(["DE_ROWS", "AUDIENCE_UPLOAD", "SUBSCRIBERS", "TRACKING_SENT", "TRACKING_OPEN", "TRACKING_CLICK", "TRACKING_BOUNCE", "TRACKING_UNSUB", "TRACKING_NOTSENT"]);

async function recordTableCount(d: SalesforceBackupDataset): Promise<number | null> {
  if (d.kind === "DE_ROWS" || d.kind === "AUDIENCE_UPLOAD") return prisma.salesforceDataExtensionRow.count({ where: { datasetId: d.id } });
  if (d.kind === "SUBSCRIBERS") return prisma.salesforceSubscriber.count({ where: { datasetId: d.id } });
  if (TRACKING_KIND_TO_EVENT[d.kind]) return prisma.salesforceTrackingEvent.count({ where: { datasetId: d.id } });
  return null;
}

const n = (v: unknown) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

/** Independent count for tracking datasets from the Send object's aggregate counters. */
async function trackingSourceCheck(d: SalesforceBackupDataset, params: DatasetParams, retentionDays: number | null): Promise<{ check: VerificationCheck; notRetrievable?: boolean }> {
  const eventType = TRACKING_KIND_TO_EVENT[d.kind]!;
  const job = params.jobId ? await prisma.salesforceEmailJob.findUnique({ where: { connectionId_mid_jobId: { connectionId: d.connectionId, mid: d.mid, jobId: params.jobId } } }) : null;
  const label = "Independent count (Send object aggregate)";
  if (!job) return { check: { key: "source_count", label, status: "na", detail: "No Send object archived for this JobID — no independent count available (verification limited)." } };
  const c = job.counters as Record<string, string | null>;
  const [distinctEvents, distinctSubs] = await Promise.all([
    prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(DISTINCT fingerprint) AS c FROM salesforce_tracking_events WHERE dataset_id = ${d.id}`,
    prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(DISTINCT subscriber_key) AS c FROM salesforce_tracking_events WHERE dataset_id = ${d.id}`,
  ]);
  const events = Number(distinctEvents[0]?.c ?? 0);
  const subs = Number(distinctSubs[0]?.c ?? 0);
  let expected: number | null = null;
  let actual = events;
  let basis = "";
  switch (eventType) {
    case "SENT":
      expected = n(c.NumberSent);
      basis = "distinct SentEvents vs Send.NumberSent";
      break;
    case "OPEN":
      expected = n(c.UniqueOpens);
      actual = subs;
      basis = "distinct subscribers with OpenEvents vs Send.UniqueOpens";
      break;
    case "CLICK":
      expected = n(c.UniqueClicks);
      actual = subs;
      basis = "distinct subscribers with ClickEvents vs Send.UniqueClicks";
      break;
    case "BOUNCE": {
      const parts = [n(c.HardBounces), n(c.SoftBounces), n(c.OtherBounces)];
      expected = parts.every((p) => p === null) ? null : parts.reduce<number>((a, b) => a + (b ?? 0), 0);
      basis = "distinct BounceEvents vs Send.HardBounces+SoftBounces+OtherBounces";
      break;
    }
    case "UNSUB":
      expected = n(c.Unsubscribes);
      basis = "distinct UnsubEvents vs Send.Unsubscribes";
      break;
    default:
      expected = null;
  }
  const sendDate = job.sentDate ?? job.sendDate;
  const ageDays = sendDate ? (Date.now() - sendDate.getTime()) / 86_400_000 : null;
  const beyondRetention = retentionDays !== null && ageDays !== null && ageDays > retentionDays;
  if (expected === null) {
    if (actual === 0 && beyondRetention) {
      return { notRetrievable: true, check: { key: "source_count", label, status: "info", detail: `No events returned and no counter to compare. The send is ${Math.floor(ageDays!)} days old, beyond the configured ${retentionDays}-day retention window: NOT RETRIEVABLE FROM THIS SOURCE (zero cannot be confirmed).` } };
    }
    return { check: { key: "source_count", label, status: "na", detail: "Salesforce exposes no aggregate counter for this event type — verification limited to extraction integrity." } };
  }
  if (actual === 0 && expected > 0 && beyondRetention) {
    return {
      notRetrievable: true,
      check: { key: "source_count", label, status: "info", detail: `Source returned 0 events but Send reports ${expected}. The send is ${Math.floor(ageDays!)} days old, beyond the configured ${retentionDays}-day tracking retention window: NOT RETRIEVABLE FROM THIS SOURCE (not "zero events").` },
    };
  }
  if (actual === expected) return { check: { key: "source_count", label, status: "pass", detail: `${basis}: ${actual} = ${expected}` } };
  return {
    check: {
      key: "source_count",
      label,
      status: actual === 0 ? "fail" : "warn",
      detail: `${basis}: archived ${actual}, Salesforce reports ${expected} (difference ${actual - expected}). Aggregate counters and event objects can legitimately differ (e.g. counting rules, late events); treat as unverified until explained.`,
    },
  };
}

export async function computeChecks(d: SalesforceBackupDataset): Promise<{ checks: VerificationCheck[]; status: SfVerificationStatus; notRetrievable: boolean }> {
  const checks: VerificationCheck[] = [];
  if (d.status === "NOT_ACCESSIBLE") return { checks: [{ key: "access", label: "Access", status: "fail", detail: d.errorMessage ?? "Not accessible" }], status: "NOT_ACCESSIBLE", notRetrievable: false };
  if (d.status === "FAILED" || d.status === "CANCELLED") return { checks: [{ key: "extraction", label: "Extraction", status: "fail", detail: d.errorMessage ?? d.status }], status: d.status === "FAILED" ? "FAILED" : "UNVERIFIED", notRetrievable: false };
  if (d.status !== "EXTRACTED" && d.status !== "NOT_RETRIEVABLE") return { checks: [{ key: "extraction", label: "Extraction", status: "fail", detail: `Extraction not finished (${d.status})` }], status: "UNVERIFIED", notRetrievable: false };

  const params = d.params as unknown as DatasetParams;
  const cp = (d.checkpoint ?? {}) as DatasetCheckpoint;
  const conn = await prisma.salesforceConnection.findUnique({ where: { id: d.connectionId } });
  const settings = parseSettings(conn?.settings);
  const pages = await prisma.salesforceBackupPage.findMany({ where: { datasetId: d.id }, orderBy: { pageNo: "asc" } });

  // 1. Page sequence and attempt consistency
  const seqOk = pages.every((p, i) => p.pageNo === i + 1 && p.attempt === d.attempt) && pages.length === d.pagesFetched;
  checks.push({ key: "page_sequence", label: "Page sequence", status: seqOk ? "pass" : "fail", detail: seqOk ? `${pages.length} pages, contiguous 1…${pages.length}, attempt ${d.attempt}` : `Missing or out-of-order pages (stored ${pages.length}, expected ${d.pagesFetched})` });

  // 2. Pagination terminated with OK, and intermediate pages are full
  if (params.channel === "soap" && params.requests) {
    let offset = 0;
    const anomalies: string[] = [];
    let terminalOk = true;
    params.requests.forEach((req, idx) => {
      const rp = cp.requestPages?.[idx];
      const count = rp?.pages ?? 0;
      const group = pages.slice(offset, offset + count);
      offset += count;
      if (!count || rp?.lastStatus !== "OK") terminalOk = false;
      group.slice(0, -1).forEach((p) => {
        if (p.recordCount !== params.pageLimit) anomalies.push(`${req.objectType}${req.tag ? `[${req.tag}]` : ""} page ${p.pageNo}: ${p.recordCount} records (expected ${params.pageLimit})`);
      });
    });
    checks.push({ key: "pagination_terminal", label: "Pagination completed", status: terminalOk ? "pass" : "fail", detail: terminalOk ? `${params.requests.length} retrieve request(s) ended with OverallStatus OK` : "A retrieve request did not end with OverallStatus OK" });
    checks.push({ key: "page_sizes", label: "Intermediate page sizes", status: anomalies.length ? "warn" : "pass", detail: anomalies.length ? `Non-full intermediate pages (possible gap): ${anomalies.slice(0, 5).join("; ")}` : `Every non-final page held exactly ${params.pageLimit} records` });
  } else if (params.channel === "rest") {
    const last = pages[pages.length - 1];
    checks.push({ key: "pagination_terminal", label: "Pagination completed", status: !pages.length || last?.overallStatus === "OK" ? "pass" : "fail", detail: `${pages.length} REST page(s)` });
  }

  // 3. Counts agree: pages ↔ dataset counter ↔ record table
  const pageSum = pages.reduce((a, p) => a + p.recordCount, 0);
  const tableCount = await recordTableCount(d);
  const countOk = pageSum === d.recordsExtracted && (tableCount === null || tableCount === pageSum);
  checks.push({
    key: "record_count",
    label: "Record counts agree",
    status: countOk ? "pass" : "fail",
    detail: `pages sum ${pageSum} · dataset counter ${d.recordsExtracted}${tableCount !== null ? ` · archived rows ${tableCount}` : ""}`,
  });

  // 4. Raw payload integrity (decrypt + SHA-256)
  const bad: string[] = [];
  for (const p of pages) {
    const r = await verifyObject(p.storageKey, p.sha256);
    if (!r.ok) bad.push(`page ${p.pageNo}: ${r.reason}`);
  }
  checks.push({ key: "raw_integrity", label: "Raw payload integrity (SHA-256)", status: bad.length ? "fail" : "pass", detail: bad.length ? bad.slice(0, 5).join("; ") : `${pages.length} raw page(s) decrypted and re-hashed successfully` });

  // 5. Duplicates
  if (d.kind === "DE_ROWS" || d.kind === "AUDIENCE_UPLOAD") {
    if (params.primaryKeyFields?.length) {
      const dup = await prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM (SELECT primary_key FROM salesforce_data_extension_rows WHERE dataset_id = ${d.id} GROUP BY primary_key HAVING COUNT(*) > 1) x`;
      const c = Number(dup[0]?.c ?? 0);
      checks.push({ key: "duplicates", label: "Primary-key duplicates", status: c ? "fail" : "pass", detail: c ? `${c} primary-key value(s) appear more than once — extraction overlap or source anomaly` : `No duplicate primary keys (${params.primaryKeyFields.join(", ")})` });
    } else {
      const dup = await prisma.$queryRaw<{ g: bigint; r: bigint }[]>`SELECT COUNT(*) AS g, COALESCE(SUM(c),0) AS r FROM (SELECT COUNT(*) AS c FROM salesforce_data_extension_rows WHERE dataset_id = ${d.id} GROUP BY row_hash HAVING COUNT(*) > 1) x`;
      const g = Number(dup[0]?.g ?? 0);
      checks.push({ key: "duplicates", label: "Identical rows", status: "info", detail: g ? `${g} distinct row value(s) occur more than once (${Number(dup[0]?.r ?? 0)} rows). This DE has no primary key, so identical rows can be genuine source data; they are preserved, not removed.` : "No identical rows" });
    }
  } else if (TRACKING_KIND_TO_EVENT[d.kind]) {
    const dup = await prisma.$queryRaw<{ g: bigint; r: bigint }[]>`SELECT COUNT(*) AS g, COALESCE(SUM(c),0) AS r FROM (SELECT COUNT(*) AS c FROM salesforce_tracking_events WHERE dataset_id = ${d.id} GROUP BY fingerprint HAVING COUNT(*) > 1) x`;
    const g = Number(dup[0]?.g ?? 0);
    checks.push({ key: "duplicates", label: "Identical tracking rows", status: "info", detail: g ? `${g} event(s) returned more than once by Salesforce (${Number(dup[0]?.r ?? 0)} rows). All rows are preserved; derived counts use distinct events.` : "No identical event rows" });
  } else if (d.kind === "SUBSCRIBERS") {
    const dup = await prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM (SELECT subscriber_key FROM salesforce_subscribers WHERE dataset_id = ${d.id} GROUP BY subscriber_key HAVING COUNT(*) > 1) x`;
    const c = Number(dup[0]?.c ?? 0);
    checks.push({ key: "duplicates", label: "Duplicate SubscriberKeys", status: c ? "warn" : "pass", detail: c ? `${c} SubscriberKey(s) appear more than once` : "Each SubscriberKey appears once" });
  }

  // 6. Source-to-archive field validation (DE rows)
  if (d.kind === "DE_ROWS" && params.schema?.length) {
    const names = params.schema.map((f) => f.name);
    const missing = await prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM salesforce_data_extension_rows WHERE dataset_id = ${d.id} AND NOT (values ?& ${names}::text[])`;
    const numericFields = params.schema.filter((f) => f.fieldType === "Number" || f.fieldType === "Decimal").map((f) => f.name);
    let badNumeric = 0;
    for (const f of numericFields) {
      const r = await prisma.$queryRaw<{ c: bigint }[]>`SELECT COUNT(*) AS c FROM salesforce_data_extension_rows WHERE dataset_id = ${d.id} AND COALESCE(values->>${f}, '') <> '' AND NOT (values->>${f} ~ '^-?[0-9]+(\\.[0-9]+)?$')`;
      badNumeric += Number(r[0]?.c ?? 0);
    }
    const m = Number(missing[0]?.c ?? 0);
    checks.push({
      key: "field_validation",
      label: "Field validation vs schema",
      status: m ? "fail" : badNumeric ? "warn" : "pass",
      detail: m ? `${m} row(s) lack one or more schema fields` : `All rows carry the ${names.length} schema fields as strings (leading zeros preserved)${badNumeric ? `; ${badNumeric} non-numeric value(s) in Number/Decimal fields` : ""}`,
    });
  }

  // 7. Dropped properties
  const dropped = Object.entries(params.droppedProperties ?? {});
  if (dropped.length) checks.push({ key: "dropped_properties", label: "Unavailable properties", status: "warn", detail: `Rejected by this account and therefore not archived: ${dropped.map(([o, ps]) => `${o}: ${ps.join(", ")}`).join("; ")}` });

  // 8. Independent source count
  let notRetrievable = false;
  if (TRACKING_KIND_TO_EVENT[d.kind]) {
    const r = await trackingSourceCheck(d, params, settings.retention.soapTracking.days);
    checks.push(r.check);
    notRetrievable = !!r.notRetrievable;
  } else if (params.channel === "rest" && d.sourceCount !== null) {
    checks.push({ key: "source_count", label: "Independent count (REST total)", status: d.sourceCount === d.recordsExtracted ? "pass" : "fail", detail: `Salesforce-reported total ${d.sourceCount} vs archived ${d.recordsExtracted}` });
  } else if (d.kind === "DE_ROWS" && params.dataExtensionId) {
    const de = await prisma.salesforceDataExtension.findUnique({ where: { id: params.dataExtensionId } });
    if (de?.attestedCount !== null && de?.attestedCount !== undefined) {
      const ok = de.attestedCount === d.recordsExtracted;
      checks.push({
        key: "source_count",
        label: "Independent count (operator-attested UI count)",
        status: ok ? "pass" : "warn",
        detail: `${de.attestedByEmail ?? "an operator"} recorded ${de.attestedCount} records in the Salesforce UI on ${de.attestedAt?.toISOString().slice(0, 10)}; archived ${d.recordsExtracted}.${ok ? "" : " Rows may have changed between the UI reading and the extraction."}`,
      });
    } else {
      checks.push({ key: "source_count", label: "Independent count", status: "na", detail: "Salesforce offers no documented API row count for Data Extensions. Record the count shown in Email Studio/Contact Builder (Attest source count) to fully verify; until then verification is LIMITED." });
    }
  } else if (d.kind === "EMAILS") {
    const requested = new Set((params.requests ?? []).flatMap((r) => (r.filter && "values" in r.filter ? (r.filter.values ?? []) : [])));
    const got = new Set((await prisma.salesforceEmail.findMany({ where: { datasetId: d.id }, select: { emailId: true } })).map((e) => e.emailId));
    const missing = [...requested].filter((id) => !got.has(id));
    const noBody = await prisma.salesforceEmail.count({ where: { datasetId: d.id, htmlStorageKey: null, textStorageKey: null } });
    checks.push({
      key: "source_count",
      label: "Emails requested vs returned",
      status: missing.length ? "warn" : "pass",
      detail: `${got.size} of ${requested.size} email(s) referenced by send jobs were returned${missing.length ? `; not returned (likely deleted in Salesforce): ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? "…" : ""}` : ""}.${noBody ? ` ${noBody} returned without an HTML or text body (e.g. Content Builder emails whose body is only in the asset).` : ""}`,
    });
  } else if (d.kind === "CONTENT_FILES") {
    const attempted = params.files?.length ?? 0;
    const failed = await prisma.salesforceContentFile.findMany({ where: { datasetId: d.id, storageKey: null }, select: { url: true, httpStatus: true, error: true }, take: 10 });
    checks.push({
      key: "source_count",
      label: "Files downloaded",
      status: d.recordsExtracted === attempted ? "pass" : "warn",
      detail: `${d.recordsExtracted} of ${attempted} referenced file(s) downloaded and hashed${d.recordsExtracted === attempted ? "" : `; unavailable: ${failed.map((f) => `${f.url} (${f.error ?? f.httpStatus})`).join("; ")}`}.`,
    });
  } else if (d.kind === "AUDIENCE_UPLOAD") {
    checks.push({ key: "source_count", label: "Upload integrity", status: "info", detail: `Uploaded file SHA-256 ${params.upload?.sha256.slice(0, 16)}… (${params.upload?.bytes} bytes). Its provenance is as described by the uploader.` });
  } else {
    checks.push({ key: "source_count", label: "Independent count", status: "na", detail: "No independent count is available for this object — verification limited to extraction integrity." });
  }

  const statuses = checks.map((c) => c.status);
  let status: SfVerificationStatus;
  if (statuses.includes("fail")) status = "FAILED";
  else if (notRetrievable) status = "NOT_RETRIEVABLE";
  else if (checks.find((c) => c.key === "source_count")?.status === "pass" && !statuses.includes("warn")) status = "VERIFIED";
  else status = "PARTIALLY_VERIFIED";
  return { checks, status, notRetrievable };
}

/** Verify, write a manifest version, and seal the dataset (rows become immutable). */
export async function verifyAndSeal(datasetId: string): Promise<SfVerificationStatus> {
  const d = await prisma.salesforceBackupDataset.findUniqueOrThrow({ where: { id: datasetId } });
  const { checks, status, notRetrievable } = await computeChecks(d);
  const now = new Date();
  const updated = await prisma.salesforceBackupDataset.update({
    where: { id: d.id },
    data: {
      ...(d.sealedAt ? {} : { sealedAt: now, ...(notRetrievable && d.status === "EXTRACTED" ? { status: "NOT_RETRIEVABLE" as const } : {}) }),
      verificationStatus: status,
      verificationDetails: { checks, limited: !checks.some((c) => c.key === "source_count" && c.status === "pass") } as unknown as Prisma.InputJsonValue,
      verifiedAt: now,
    },
  });
  if (updated.kind === "DE_ROWS" && (updated.status === "EXTRACTED") && (updated.params as unknown as DatasetParams).dataExtensionId) {
    await prisma.salesforceDataExtension.update({ where: { id: (updated.params as unknown as DatasetParams).dataExtensionId! }, data: { latestRowsDatasetId: updated.id } });
  }
  await writeDatasetManifest(updated.id);
  await extractionLog({ backupJobId: d.backupJobId, datasetId: d.id, level: status === "FAILED" ? "error" : "info", message: `Verification ${status}: ${d.label}`, data: { checks: checks.map((c) => `${c.key}:${c.status}`) } });
  return status;
}

/** Re-run verification on demand (e.g. after attesting a DE count). Writes a new manifest version. */
export async function reverifyDataset(datasetId: string) {
  return verifyAndSeal(datasetId);
}

export function rollupStatus(statuses: SfVerificationStatus[]): SfVerificationStatus {
  if (!statuses.length) return "UNVERIFIED";
  if (statuses.every((s) => s === "VERIFIED")) return "VERIFIED";
  if (statuses.every((s) => s === "FAILED")) return "FAILED";
  if (statuses.every((s) => s === "NOT_ACCESSIBLE")) return "NOT_ACCESSIBLE";
  if (statuses.every((s) => s === "UNVERIFIED")) return "UNVERIFIED";
  return "PARTIALLY_VERIFIED";
}

export { RECORD_TABLE_KINDS };
