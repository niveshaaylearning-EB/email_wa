/**
 * Evidence layer: exports (streaming, value fidelity, formula safety), signed downloads,
 * audience uploads, evidence packages (hashes, PDF), schedules.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { drainInlineQueue } from "@/lib/queue";
import { createUser, resetDb } from "../support/db";
import { saveConnection, setSimulatorFor } from "@/lib/services/salesforce/connections";
import { createBackupJob, createSchedule, sfmcSchedulerTick } from "@/lib/services/salesforce/backups";
import { createReconciliation } from "@/lib/services/salesforce/reconciliation";
import { buildExport, signDownload, verifyDownload } from "@/lib/services/salesforce/exports";
import { generateEvidencePackage } from "@/lib/services/salesforce/evidence";
import { uploadAudienceSnapshot, UploadMetaSchema } from "@/lib/services/salesforce/operations";
import { clearTestArchive, getObject, sha256Hex } from "@/lib/salesforce/storage";
import { createSimulatedFetch, SIM_MAIN_DE, SIM_MAIN_JOB, SIM_RESEARCH_MID } from "@/lib/salesforce/simulator";
import type { ReconSummary } from "@/lib/domain/salesforce-reconcile";

async function text(stream: ReadableStream<Uint8Array>) {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(await new Response(stream).arrayBuffer());
}

async function setup() {
  const admin = await createUser("ADMIN");
  const conn = await saveConnection(null, { name: "Sim", kind: "SIMULATED", defaultMid: SIM_RESEARCH_MID, settings: { simulator: { pageSize: 50, scale: 0.02 } } }, admin);
  setSimulatorFor(conn.id, createSimulatedFetch({ pageSize: 50, scale: 0.02 }));
  return { admin, conn };
}

beforeEach(async () => {
  await resetDb();
  await clearTestArchive();
});

describe("exports", () => {
  it("streams DE rows with exact values (JSONL) and formula-safe CSV", async () => {
    const { admin, conn } = await setup();
    const job = await createBackupJob({ connectionId: conn.id, mids: [SIM_RESEARCH_MID], dataTypes: ["de_metadata", "de_rows"], deKeys: [SIM_MAIN_DE], mode: "FULL", refreshRecentDays: 14 }, admin);
    await drainInlineQueue();
    const ds = await prisma.salesforceBackupDataset.findFirstOrThrow({ where: { backupJobId: job.id, kind: "DE_ROWS" } });
    const jsonl = await text((await buildExport({ type: "dataset_rows", datasetId: ds.id, format: "jsonl", safe: true })).stream);
    const lines = jsonl.trim().split("\n");
    expect(lines).toHaveLength(ds.recordsExtracted);
    expect(JSON.parse(lines[0]).PortfolioCode).toMatch(/^00\d{4}$/); // leading zeros intact
    const csv = await text((await buildExport({ type: "dataset_rows", datasetId: ds.id, format: "csv", safe: true })).stream);
    expect(csv.startsWith("﻿_page,_row,SubscriberKey")).toBe(true);
    expect(csv.trim().split("\r\n")).toHaveLength(ds.recordsExtracted + 1);
  });

  it("signed download links are user-bound and expire", async () => {
    const spec = { type: "email_jobs" as const, format: "csv" as const, safe: true };
    const { token } = signDownload(spec, "user-a");
    expect(verifyDownload(token, "user-a")).toMatchObject({ type: "email_jobs" });
    expect(() => verifyDownload(token, "user-b")).toThrow(/another user/);
    const tampered = token.replace(/^.{5}/, "AAAAA");
    expect(() => verifyDownload(tampered, "user-a")).toThrow();
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60_000;
    try {
      expect(() => verifyDownload(token, "user-a")).toThrow(/expired/);
    } finally {
      Date.now = realNow;
    }
  });
});

describe("audience uploads", () => {
  it("stores the original file, keeps values as text, and requires evidence for a historical label", async () => {
    const { admin, conn } = await setup();
    expect(UploadMetaSchema.safeParse({ label: "x file", mid: SIM_RESEARCH_MID, connectionId: conn.id, historical: true }).success).toBe(false);
    const csv = Buffer.from("SubscriberKey,Code,Note\nNIV000001,007,=SUM(A1)\nNIV000002,0042,plain\n");
    const r = await uploadAudienceSnapshot(
      { name: "audience.csv", bytes: csv },
      { label: "Imported file 11 Sep", mid: SIM_RESEARCH_MID, connectionId: conn.id, historical: true, attest: true, evidenceNote: "File attached to the import activity email of 11 Sep 2025", snapshotDate: "2025-09-11T00:00:00.000Z" },
      admin,
    );
    expect(r.rows).toBe(2);
    expect(r.sha256).toBe(sha256Hex(csv));
    const ds = await prisma.salesforceBackupDataset.findUniqueOrThrow({ where: { id: r.datasetId } });
    expect(ds.sealedAt).not.toBeNull();
    expect(ds.verificationStatus).toBe("PARTIALLY_VERIFIED");
    const stored = await getObject((ds.params as { upload: { storageKey: string } }).upload.storageKey);
    expect(stored.equals(csv)).toBe(true);
    const rows = await prisma.salesforceDataExtensionRow.findMany({ where: { datasetId: ds.id }, orderBy: { rowNo: "asc" } });
    expect((rows[0].values as Record<string, string>).Code).toBe("007");
    const safe = await text((await buildExport({ type: "dataset_rows", datasetId: ds.id, format: "csv", safe: true })).stream);
    expect(safe).toContain("'=SUM(A1)");
    const raw = await text((await buildExport({ type: "dataset_rows", datasetId: ds.id, format: "csv", safe: false })).stream);
    expect(raw).toContain(",=SUM(A1)");
  });
});

describe("evidence packages", () => {
  it("builds a reconciliation package with hashed report, CSV, PDF and manifest", async () => {
    const { admin, conn } = await setup();
    const job = await createBackupJob({ connectionId: conn.id, mids: [SIM_RESEARCH_MID], dataTypes: ["de_metadata", "de_rows", "email_jobs", "tracking_sent", "tracking_notsent"], deKeys: [SIM_MAIN_DE], mode: "FULL", refreshRecentDays: 14 }, admin);
    await drainInlineQueue();
    const audience = await prisma.salesforceBackupDataset.findFirstOrThrow({ where: { backupJobId: job.id, kind: "DE_ROWS" } });
    const rec = await createReconciliation({ name: "Q3", mid: SIM_RESEARCH_MID, jobIds: [SIM_MAIN_JOB], audienceDatasetId: audience.id, audienceField: "SubscriberKey", identityMode: "SUBSCRIBER_KEY", caseInsensitive: false, trim: true, exclusionDatasetIds: [], exclusionField: "SubscriberKey" }, admin);
    await drainInlineQueue();
    const pkg = await generateEvidencePackage({ kind: "RECONCILIATION", reconciliationId: rec.id }, admin);
    const files = pkg.files as { name: string; sha256: string; storageKey: string }[];
    expect(files.map((f) => f.name).sort()).toEqual(["package-manifest.json", "recipients.csv", "report.json", "summary.pdf"]);
    for (const f of files) expect(sha256Hex(await getObject(f.storageKey))).toBe(f.sha256);
    const pdf = await getObject(files.find((f) => f.name === "summary.pdf")!.storageKey);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const report = JSON.parse((await getObject(files.find((f) => f.name === "report.json")!.storageKey)).toString());
    const s = (await prisma.salesforceReconciliationJob.findUniqueOrThrow({ where: { id: rec.id } })).summary as unknown as ReconSummary;
    expect(report.derivedCalculations.audienceRowCount).toBe(s.audienceRows);
    expect(report.disclaimer).toMatch(/not a certification/);
    for (const k of ["sourceRecords", "extractedCopies", "derivedCalculations", "assumptions", "missingEvidence", "limitations", "methodology"]) expect(report).toHaveProperty(k);
    const csv = (await getObject(files.find((f) => f.name === "recipients.csv")!.storageKey)).toString();
    expect(csv.trim().split("\r\n").length).toBe((await prisma.salesforceReconciliationResult.count({ where: { reconciliationId: rec.id } })) + 1);
    // Packages are immutable
    await expect(prisma.salesforceEvidencePackage.update({ where: { id: pkg.id }, data: { title: "x" } })).rejects.toThrow(/append-only/);
    expect(await prisma.salesforceArchiveAuditLog.count({ where: { action: "archive.evidence.generated" } })).toBe(1);
  });

  it("builds a campaign package", async () => {
    const { admin, conn } = await setup();
    await createBackupJob({ connectionId: conn.id, mids: [SIM_RESEARCH_MID], dataTypes: ["email_jobs", "tracking_sent", "tracking_open"], jobIds: [SIM_MAIN_JOB], mode: "FULL", refreshRecentDays: 14 }, admin);
    await drainInlineQueue();
    const pkg = await generateEvidencePackage({ kind: "CAMPAIGN", mid: SIM_RESEARCH_MID, jobId: SIM_MAIN_JOB }, admin);
    const report = JSON.parse((await getObject((pkg.files as { name: string; storageKey: string }[]).find((f) => f.name === "report.json")!.storageKey)).toString());
    expect(report.missingEvidence.join(" ")).toMatch(/CLICK events: not archived/);
    expect(report.derivedCalculations.byEventType.find((e: { eventType: string }) => e.eventType === "SENT").distinctEvents).toBeGreaterThan(0);
  });
});

describe("schedules", () => {
  it("creates an incremental backup when due and never twice for one slot", async () => {
    const { admin, conn } = await setup();
    const s = await createSchedule({ connectionId: conn.id, name: "nightly", mids: [SIM_RESEARCH_MID], dataTypes: ["lists"], intervalHours: 24, firstRunAt: new Date(Date.now() - 1000).toISOString() }, admin);
    await Promise.all([sfmcSchedulerTick(), sfmcSchedulerTick()]);
    const jobs = await prisma.salesforceBackupJob.findMany({ where: { scheduleId: s.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].mode).toBe("INCREMENTAL");
    const after = await prisma.salesforceBackupSchedule.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
  });
});

describe("email content", () => {
  it("archives the HTML of every sent email, its images, and flags emails edited after the send", async () => {
    const { admin, conn } = await setup();
    const job = await createBackupJob({ connectionId: conn.id, mids: [SIM_RESEARCH_MID], dataTypes: ["email_jobs", "content", "emails", "content_files"], mode: "FULL", refreshRecentDays: 14 }, admin);
    await drainInlineQueue();
    const ds = await prisma.salesforceBackupDataset.findMany({ where: { backupJobId: job.id } });
    const emails = ds.find((d) => d.kind === "EMAILS")!;
    expect(emails.status).toBe("EXTRACTED");
    // 6 send jobs reference 6 emails; the 2023 email was deleted in Salesforce → reported, not hidden
    expect(await prisma.salesforceEmail.count()).toBe(5);
    const emailCheck = (emails.verificationDetails as { checks: { key: string; status: string; detail: string }[] }).checks.find((c) => c.key === "source_count")!;
    expect(emailCheck.status).toBe("warn");
    expect(emailCheck.detail).toMatch(/79011/);
    // HTML stored unaltered, hashed
    const main = await prisma.salesforceEmail.findFirstOrThrow({ where: { emailId: "88231" } });
    const html = (await getObject(main.htmlStorageKey!)).toString();
    expect(html).toContain("%%FirstName%%");
    expect(sha256Hex(html)).toBe(main.htmlSha256);
    // Edited after send is detectable
    const sent = await prisma.salesforceEmailJob.findFirstOrThrow({ where: { jobId: SIM_MAIN_JOB } });
    expect(main.modifiedAt!.getTime()).toBeGreaterThan((sent.sentDate ?? sent.sendDate)!.getTime());
    // Images: logo downloaded and hashed; missing chart recorded as a gap, never silently dropped
    const files = ds.find((d) => d.kind === "CONTENT_FILES")!;
    expect(files.recordsExtracted).toBeGreaterThanOrEqual(1);
    const logo = await prisma.salesforceContentFile.findFirstOrThrow({ where: { url: { endsWith: "logo.png" } } });
    expect(sha256Hex(await getObject(logo.storageKey!))).toBe(logo.sha256);
    const chart = await prisma.salesforceContentFile.findFirstOrThrow({ where: { url: { endsWith: "chart.png" } } });
    expect(chart.storageKey).toBeNull();
    expect(chart.httpStatus).toBe(404);
    expect(files.verificationStatus).toBe("PARTIALLY_VERIFIED");
  });
});
