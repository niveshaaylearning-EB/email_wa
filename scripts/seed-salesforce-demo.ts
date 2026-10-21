/**
 * DEVELOPMENT DEMO for the Salesforce Archive — drives the real services against the built-in
 * SIMULATED Marketing Cloud tenant (synthetic data, labelled SIMULATED everywhere):
 * connection test, BU discovery, a full backup (DEs, subscribers, send jobs, recipient-level
 * tracking, journeys, automations, content), the 18,000-vs-16,000 reconciliation and an
 * evidence package. Refuses to run when NODE_ENV=production.
 *
 *   npm run db:seed:salesforce            (SFMC_DEMO_SCALE=0.1 for a faster, smaller run)
 *
 * Note: archived rows are immutable once sealed. Run this against a development database
 * you are happy to keep demo data in (it is flagged is_simulated = true).
 */
import "dotenv/config";
import { prisma } from "@/lib/db";
import { ensureRoles } from "@/lib/services/users";
import { hashPassword } from "@/lib/auth/session";
import { drainInlineQueue, setInlineMode } from "@/lib/queue";
import { discoverBusinessUnits, saveConnection, setBusinessUnitSelection, testConnection } from "@/lib/services/salesforce/connections";
import { createBackupJob } from "@/lib/services/salesforce/backups";
import { createReconciliation } from "@/lib/services/salesforce/reconciliation";
import { generateEvidencePackage } from "@/lib/services/salesforce/evidence";
import { BACKUP_DATA_TYPES } from "@/lib/salesforce/objects";
import { SIM_MAIN_DE, SIM_MAIN_JOB, SIM_RESEARCH_MID } from "@/lib/salesforce/simulator";
import type { ReconSummary } from "@/lib/domain/salesforce-reconcile";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to load simulated Salesforce data in production.");
  process.exit(1);
}
setInlineMode("manual");

async function main() {
  const t0 = Date.now();
  await ensureRoles();
  let admin = await prisma.user.findFirst({ where: { role: { key: "ADMIN" }, isActive: true, deletedAt: null }, orderBy: { createdAt: "asc" } });
  if (!admin) {
    const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
    admin = await prisma.user.create({ data: { email: process.env.SEED_ADMIN_EMAIL || "admin@niveshaay.local", name: "Administrator", roleId: role.id, passwordHash: await hashPassword(process.env.SEED_ADMIN_PASSWORD || "Niveshaay@Dev2026") } });
    console.log(`created admin ${admin.email}`);
  }
  const actor = { id: admin.id, email: admin.email };
  const scale = Number(process.env.SFMC_DEMO_SCALE ?? 1);

  let conn = await prisma.salesforceConnection.findFirst({ where: { kind: "SIMULATED", archivedAt: null } });
  if (!conn) conn = await saveConnection(null, { name: "Simulated Marketing Cloud (demo)", kind: "SIMULATED", defaultMid: SIM_RESEARCH_MID, settings: { simulator: { pageSize: 2500, scale } } }, actor);
  const test = await testConnection(conn.id, actor);
  console.log(`connection test: ${test.ok ? "ok" : test.message}`);
  await discoverBusinessUnits(conn.id, actor);
  await setBusinessUnitSelection(conn.id, [SIM_RESEARCH_MID], actor);

  console.log("running full backup (this extracts every page through the SOAP/REST protocol)…");
  const job = await createBackupJob({ connectionId: conn.id, mids: [SIM_RESEARCH_MID], dataTypes: BACKUP_DATA_TYPES.map((t) => t.key), mode: "FULL", refreshRecentDays: 14 }, actor);
  await drainInlineQueue();
  const done = await prisma.salesforceBackupJob.findUniqueOrThrow({ where: { id: job.id } });
  console.log(`backup ${done.code}: ${done.status} · verification ${done.verificationStatus} · ${JSON.stringify(done.stats)}`);

  const audience = await prisma.salesforceBackupDataset.findFirstOrThrow({ where: { backupJobId: job.id, kind: "DE_ROWS", sourceKey: SIM_MAIN_DE } });
  const rec = await createReconciliation(
    { name: "Q3 research update — audience vs sends", mid: SIM_RESEARCH_MID, jobIds: [SIM_MAIN_JOB], audienceDatasetId: audience.id, audienceField: "SubscriberKey", identityMode: "SUBSCRIBER_KEY", caseInsensitive: false, trim: true, exclusionDatasetIds: [], exclusionField: "SubscriberKey" },
    actor,
  );
  await drainInlineQueue();
  const r = await prisma.salesforceReconciliationJob.findUniqueOrThrow({ where: { id: rec.id } });
  const s = r.summary as unknown as ReconSummary;
  console.log(`reconciliation ${r.code}: audience rows ${s.audienceRows} → unique recipients with SentEvent ${s.uniqueRecipientsWithSentEvent} (unresolved ${s.unresolved})`);
  const pkg = await generateEvidencePackage({ kind: "RECONCILIATION", reconciliationId: rec.id }, actor);
  console.log(`evidence package ${pkg.code}`);
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s — open /salesforce`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
