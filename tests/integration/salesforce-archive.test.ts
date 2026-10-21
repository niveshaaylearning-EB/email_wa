/**
 * Salesforce archive end-to-end tests against the in-process SIMULATED Marketing Cloud tenant
 * (same wire protocol as production: OAuth token, SOAP Retrieve/ContinueRequest, REST paging).
 * Small scale + small pages so every dataset spans several pages.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { drainInlineQueue } from "@/lib/queue";
import { createUser, resetDb } from "../support/db";
import { saveConnection, setSimulatorFor, testConnection, discoverBusinessUnits } from "@/lib/services/salesforce/connections";
import { createBackupJob, retryFailedDatasets } from "@/lib/services/salesforce/backups";
import { verifyManifestChain } from "@/lib/services/salesforce/manifests";
import { createReconciliation } from "@/lib/services/salesforce/reconciliation";
import { reverifyDataset } from "@/lib/services/salesforce/verification";
import { clearTestArchive } from "@/lib/salesforce/storage";
import { createSimulatedFetch, SIM_MAIN_DE, SIM_MAIN_JOB, SIM_RESEARCH_MID, type SimOptions } from "@/lib/salesforce/simulator";
import type { ReconSummary } from "@/lib/domain/salesforce-reconcile";

const SCALE = 0.02;
const PAGE = 50;

async function setup(sim: SimOptions = {}) {
  const admin = await createUser("ADMIN");
  const conn = await saveConnection(null, { name: "Sim", kind: "SIMULATED", defaultMid: SIM_RESEARCH_MID, settings: { simulator: { pageSize: PAGE, scale: SCALE } } }, admin);
  const fetchImpl = createSimulatedFetch({ pageSize: PAGE, scale: SCALE, ...sim });
  setSimulatorFor(conn.id, fetchImpl);
  return { admin, conn, fetchImpl };
}

async function runBackup(connectionId: string, actor: { id: string; email: string }, dataTypes: string[], extra: Record<string, unknown> = {}) {
  const job = await createBackupJob({ connectionId, mids: [SIM_RESEARCH_MID], dataTypes, mode: "FULL", refreshRecentDays: 14, ...extra }, actor);
  await drainInlineQueue();
  return prisma.salesforceBackupJob.findUniqueOrThrow({ where: { id: job.id }, include: { datasets: true } });
}

beforeEach(async () => {
  await resetDb();
  await clearTestArchive();
});

describe("connection", () => {
  it("tests the connection, records scopes and capability probes, discovers BUs", async () => {
    const { admin, conn } = await setup();
    const r = await testConnection(conn.id, admin);
    expect(r.ok).toBe(true);
    expect(Object.values(r.capabilities).every((c) => c.status === "ok")).toBe(true);
    const saved = await prisma.salesforceConnection.findUniqueOrThrow({ where: { id: conn.id } });
    expect(saved.status).toBe("CONNECTED");
    expect(saved.grantedScopes).toContain("tracking_events_read");
    expect(JSON.stringify(saved)).not.toContain("sim-token"); // tokens never persisted
    const bu = await discoverBusinessUnits(conn.id, admin);
    expect(bu.count).toBe(2);
    expect(await prisma.salesforceBusinessUnit.count({ where: { connectionId: conn.id } })).toBe(2);
  });

  it("reports authentication failures with setup guidance", async () => {
    const admin = await createUser("ADMIN");
    const conn = await saveConnection(null, { name: "Bad", kind: "SIMULATED", clientId: "x", clientSecret: "invalid-secret" }, admin);
    setSimulatorFor(conn.id, { invalidSecret: "invalid-secret" });
    const r = await testConnection(conn.id, admin);
    expect(r.ok).toBe(false);
    expect(r.hint).toMatch(/Installed Packages/);
    expect((await prisma.salesforceConnection.findUniqueOrThrow({ where: { id: conn.id } })).status).toBe("ERROR");
  });

  it("records missing permissions per capability", async () => {
    const { admin, conn } = await setup({ deny: ["SentEvent", "Automation"] });
    const r = await testConnection(conn.id, admin);
    expect(r.capabilities.tracking.status).toBe("denied");
    expect(r.capabilities.automations.status).toBe("denied");
    expect(r.capabilities.data_extensions.status).toBe("ok");
  });
});

describe("backup", () => {
  it("extracts DE metadata and multi-page rows, verifies, seals and chains manifests", async () => {
    const { admin, conn, fetchImpl } = await setup();
    const job = await runBackup(conn.id, admin, ["business_units", "folders", "de_metadata", "de_rows"]);
    expect(job.status).toBe("COMPLETED_WITH_GAPS"); // DE_RESTRICTED rows are not accessible
    const main = job.datasets.find((d) => d.kind === "DE_ROWS" && d.sourceKey === SIM_MAIN_DE)!;
    expect(main.status).toBe("EXTRACTED");
    expect(main.pagesFetched).toBeGreaterThan(5);
    expect(main.sealedAt).not.toBeNull();
    // Rows come from the REST rowset resource, whose reported count is the independent check
    expect(main.verificationStatus).toBe("VERIFIED");
    expect(main.sourceCount).toBe(main.recordsExtracted);
    const rows = await prisma.salesforceDataExtensionRow.count({ where: { datasetId: main.id } });
    expect(rows).toBe(main.recordsExtracted);
    // Leading zeros preserved
    const sample = await prisma.salesforceDataExtensionRow.findFirstOrThrow({ where: { datasetId: main.id, pageNo: 1, rowNo: 1 } });
    expect((sample.values as Record<string, string>).PortfolioCode).toMatch(/^00\d{4}$/);
    // Schema + folder path
    const de = await prisma.salesforceDataExtension.findFirstOrThrow({ where: { customerKey: SIM_MAIN_DE }, include: { fields: true } });
    expect(de.fields).toHaveLength(6);
    expect(de.folderPath).toBe("Data Extensions / Research Audiences");
    expect(de.latestRowsDatasetId).toBe(main.id);
    // Inaccessible DE is reported, not silently skipped
    const restricted = job.datasets.find((d) => d.sourceKey === "DE_RESTRICTED")!;
    expect(restricted.status).toBe("NOT_ACCESSIBLE");
    expect(job.verificationStatus).not.toBe("VERIFIED");
    expect((job.verificationNotes as string[]).join(" ")).toMatch(/NOT ACCESSIBLE/);
    // Manifest chain intact
    const chain = await verifyManifestChain(job.id);
    expect(chain.ok).toBe(true);
    expect(chain.count).toBe(job.datasets.length + 1);
    // Sealed rows are immutable at the database level
    await expect(prisma.salesforceDataExtensionRow.update({ where: { id: sample.id }, data: { rowHash: "x" } })).rejects.toThrow(/immutable/);
    await expect(prisma.salesforceDataExtensionRow.deleteMany({ where: { datasetId: main.id } })).rejects.toThrow(/sealed/);
    // Read-only: every SOAP call was a Retrieve or a continuation; REST calls were rowset reads
    expect(fetchImpl.calls.filter((c) => c.channel === "soap").every((c) => /^(retrieve|continue) /.test(c.detail))).toBe(true);
    expect(fetchImpl.calls.filter((c) => c.channel === "rest").every((c) => /^rowset /.test(c.detail))).toBe(true);
  });

  it("attested source count upgrades DE verification to VERIFIED", async () => {
    const { admin, conn } = await setup();
    const job = await runBackup(conn.id, admin, ["de_metadata", "de_rows"], { deKeys: ["DE_CLIENT_MASTER"] });
    const ds = job.datasets.find((d) => d.kind === "DE_ROWS")!;
    await prisma.salesforceDataExtension.updateMany({ where: { customerKey: "DE_CLIENT_MASTER" }, data: { attestedCount: ds.recordsExtracted, attestedAt: new Date(), attestedByEmail: admin.email } });
    expect(await reverifyDataset(ds.id)).toBe("VERIFIED");
    expect(await prisma.salesforceBackupManifest.count({ where: { datasetId: ds.id } })).toBe(2); // new manifest revision
  });

  it("extracts send jobs and recipient-level tracking, verified against Send counters; old jobs are NOT RETRIEVABLE", async () => {
    const { admin, conn } = await setup();
    const job = await runBackup(conn.id, admin, ["email_jobs", "tracking_sent", "tracking_open", "tracking_bounce", "tracking_notsent"]);
    const sent = job.datasets.find((d) => d.kind === "TRACKING_SENT" && d.sourceKey === SIM_MAIN_JOB)!;
    expect(sent.verificationStatus).toBe("VERIFIED");
    const opens = job.datasets.find((d) => d.kind === "TRACKING_OPEN" && d.sourceKey === SIM_MAIN_JOB)!;
    expect(opens.verificationStatus).toBe("VERIFIED");
    // Repeated opens are stored as separate events
    const openRows = await prisma.salesforceTrackingEvent.count({ where: { datasetId: opens.id } });
    const openSubs = await prisma.salesforceTrackingEvent.groupBy({ by: ["subscriberKey"], where: { datasetId: opens.id } });
    expect(openRows).toBeGreaterThan(openSubs.length);
    // Duplicate SentEvent rows are kept and reported
    const dupCheck = ((sent.verificationDetails as { checks: { key: string; detail: string }[] }).checks.find((c) => c.key === "duplicates"))!;
    expect(dupCheck.detail).toMatch(/more than once/);
    // 2023 job: Send metadata archived, tracking outside retention → NOT_RETRIEVABLE (not "0 events")
    const old = job.datasets.find((d) => d.kind === "TRACKING_SENT" && d.sourceKey === "4301877")!;
    expect(old.status).toBe("NOT_RETRIEVABLE");
    expect(old.verificationStatus).toBe("NOT_RETRIEVABLE");
    const ej = await prisma.salesforceEmailJob.findFirstOrThrow({ where: { jobId: SIM_MAIN_JOB } });
    expect((ej.counters as Record<string, string>).NumberExcluded).toBeDefined();
    // PreviewURL is unknown to this tenant → dropped and recorded, not fatal
    const sends = job.datasets.find((d) => d.kind === "EMAIL_JOBS")!;
    expect((sends.params as { droppedProperties?: Record<string, string[]> }).droppedProperties?.Send).toContain("PreviewURL");
  });

  it("restarts cleanly when a continuation is interrupted (no gaps, no duplicates)", async () => {
    // Subscribers span several SOAP pages; find the 2nd continuation call, then fail exactly that call.
    const { admin, conn } = await setup();
    const probe = createSimulatedFetch({ pageSize: PAGE, scale: SCALE });
    setSimulatorFor(conn.id, probe);
    await runBackup(conn.id, admin, ["subscribers"]);
    const soap = probe.calls.filter((c) => c.channel === "soap");
    const continuationIndex = soap.findIndex((c, i) => c.detail.startsWith("continue") && soap[i - 1]?.detail.startsWith("continue")) + 1;
    expect(continuationIndex).toBeGreaterThan(0);

    await resetDb();
    const again = await setup({ failCall: { n: continuationIndex, kind: "network" } });
    const job = await runBackup(again.conn.id, again.admin, ["subscribers"]);
    const ds = job.datasets.find((d) => d.kind === "SUBSCRIBERS")!;
    expect(ds.attempt).toBe(2);
    expect(ds.status).toBe("EXTRACTED");
    const pages = await prisma.salesforceBackupPage.findMany({ where: { datasetId: ds.id } });
    expect(pages.every((p) => p.attempt === 2)).toBe(true);
    expect(await prisma.salesforceSubscriber.count({ where: { datasetId: ds.id } })).toBe(ds.recordsExtracted);
    const checks = (ds.verificationDetails as { checks: { key: string; status: string }[] }).checks;
    expect(checks.find((c) => c.key === "page_sequence")!.status).toBe("pass");
    expect(checks.find((c) => c.key === "record_count")!.status).toBe("pass");
    expect(await prisma.salesforceExtractionLog.count({ where: { datasetId: ds.id, message: { contains: "Restarting" } } })).toBe(1);
  });

  it("retries rate limits and refreshes expired tokens", async () => {
    for (const kind of ["429", "auth", "500"] as const) {
      await resetDb();
      const { admin, conn } = await setup({ failCall: { n: 1, kind } });
      const job = await runBackup(conn.id, admin, ["folders"]);
      expect(job.datasets[0].status).toBe("EXTRACTED");
      expect(job.status).toBe("COMPLETED");
    }
  });

  it("marks permission gaps NOT_ACCESSIBLE and never labels the job VERIFIED", async () => {
    const { admin, conn } = await setup({ deny: ["SentEvent"] });
    const job = await runBackup(conn.id, admin, ["email_jobs", "tracking_sent"]);
    const sent = job.datasets.filter((d) => d.kind === "TRACKING_SENT");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((d) => d.status === "NOT_ACCESSIBLE")).toBe(true);
    expect(job.verificationStatus).not.toBe("VERIFIED");
    expect(job.status).toBe("COMPLETED_WITH_GAPS");
  });

  it("supports cancellation between batches and retrying failed datasets", async () => {
    const { admin, conn } = await setup();
    const created = await createBackupJob({ connectionId: conn.id, mids: [SIM_RESEARCH_MID], dataTypes: ["subscribers", "lists"], mode: "FULL", refreshRecentDays: 14 }, admin);
    await prisma.salesforceBackupJob.update({ where: { id: created.id }, data: { cancelRequestedAt: new Date(), status: "CANCELLING" } });
    await drainInlineQueue();
    const job = await prisma.salesforceBackupJob.findUniqueOrThrow({ where: { id: created.id }, include: { datasets: true } });
    expect(job.status).toBe("CANCELLED");
    expect(job.datasets.every((d) => d.status === "CANCELLED" && d.sealedAt)).toBe(true);
    expect(await retryFailedDatasets(job.id, admin)).toBe(2);
    await drainInlineQueue();
    const after = await prisma.salesforceBackupJob.findUniqueOrThrow({ where: { id: job.id }, include: { datasets: true } });
    expect(after.datasets.filter((d) => !d.supersededById).every((d) => d.status === "EXTRACTED")).toBe(true);
  });
});

describe("18,000 vs 16,000 reconciliation", () => {
  it("decomposes the audience-to-send gap and keeps unexplained records UNRESOLVED", async () => {
    const { admin, conn } = await setup();
    const job = await runBackup(conn.id, admin, ["de_metadata", "de_rows", "subscribers", "email_jobs", "tracking_sent", "tracking_notsent", "tracking_bounce", "tracking_unsub"]);
    const audience = job.datasets.find((d) => d.kind === "DE_ROWS" && d.sourceKey === SIM_MAIN_DE)!;
    const rec = await createReconciliation(
      { name: "Q3 research update", mid: SIM_RESEARCH_MID, jobIds: [SIM_MAIN_JOB], audienceDatasetId: audience.id, audienceField: "SubscriberKey", identityMode: "SUBSCRIBER_KEY", caseInsensitive: false, trim: true, exclusionDatasetIds: [], exclusionField: "SubscriberKey" },
      admin,
    );
    await drainInlineQueue();
    const done = await prisma.salesforceReconciliationJob.findUniqueOrThrow({ where: { id: rec.id } });
    expect(done.status).toBe("COMPLETED");
    expect(done.audienceLabel).toBe("CURRENT_STATE"); // no evidence → never called historical
    const s = done.summary as unknown as ReconSummary;
    expect(s.audienceRows).toBe(audience.recordsExtracted);
    expect(s.duplicateAudienceRows).toBeGreaterThan(0);
    expect(s.invalidIdentifiers).toBeGreaterThan(0);
    expect(s.trackingNotInAudience).toBe(14);
    expect(s.withVerifiedNotSentEvidence).toBeGreaterThan(0); // unsubscribed / held → NotSentEvent
    expect(s.unresolved).toBeGreaterThan(0); // exclusion-list members: no recipient-level evidence
    // Every audience row is accounted for
    const audienceRowResults = await prisma.salesforceReconciliationResult.count({ where: { reconciliationId: rec.id, classification: { not: "TRACKING_NOT_IN_AUDIENCE" } } });
    expect(audienceRowResults).toBe(s.audienceRows);
    expect(s.matched + s.audienceWithoutSentEvent + s.duplicateAudienceRows + s.invalidIdentifiers).toBe(s.audienceRows);
    expect((done.limitations as string[]).join(" ")).toMatch(/does not establish inbox delivery/);
    // Completed reconciliation evidence is frozen
    await expect(prisma.salesforceReconciliationResult.deleteMany({ where: { reconciliationId: rec.id } })).rejects.toThrow(/completed/);
  });

  it("using the exclusion snapshot turns unresolved records into possible explanations, not verified ones", async () => {
    const { admin, conn } = await setup();
    const job = await runBackup(conn.id, admin, ["de_metadata", "de_rows", "email_jobs", "tracking_sent", "tracking_notsent"]);
    const audience = job.datasets.find((d) => d.kind === "DE_ROWS" && d.sourceKey === SIM_MAIN_DE)!;
    const exclusion = job.datasets.find((d) => d.kind === "DE_ROWS" && d.sourceKey === "DE_COMPLIANCE_SUPPRESS")!;
    const rec = await createReconciliation(
      { name: "with exclusions", mid: SIM_RESEARCH_MID, jobIds: [SIM_MAIN_JOB], audienceDatasetId: audience.id, audienceField: "SubscriberKey", identityMode: "SUBSCRIBER_KEY", caseInsensitive: false, trim: true, exclusionDatasetIds: [exclusion.id], exclusionField: "SubscriberKey" },
      admin,
    );
    await drainInlineQueue();
    const s = (await prisma.salesforceReconciliationJob.findUniqueOrThrow({ where: { id: rec.id } })).summary as unknown as ReconSummary;
    expect(s.withPossibleExplanationOnly).toBeGreaterThan(0);
    expect(s.flagCounts.EXCLUSION_SNAPSHOT_MEMBER).toBeGreaterThan(0);
    // The current exclusion list does not cover everyone excluded at send time → some remain unresolved
    expect(s.unresolved).toBeGreaterThan(0);
  });
});
