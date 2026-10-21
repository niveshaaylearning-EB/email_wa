/**
 * Run a Salesforce archive backup from the command line (no web server or Redis needed): the
 * same services and queue handlers as the Backup Center, driven in-process until finished.
 *
 *   SFMC_DATA_TYPES=business_units,de_metadata,email_jobs npm run sfmc:backup
 *   SFMC_RESUME=<backup code or id> npm run sfmc:backup      (continue an interrupted backup)
 *   SFMC_ALLOW_CONCURRENT=1 lets a small backup run next to one already in progress.
 *   optional: SFMC_MIDS=542000903  SFMC_DE_KEYS=key1,key2  SFMC_JOB_IDS=123,456  SFMC_FROM=2025-01-01  SFMC_TO=2025-12-31  SFMC_MODE=INCREMENTAL
 *
 * Read-only towards Salesforce. Prints a per-dataset summary; details are in the Backup Center.
 */
import "dotenv/config";
import { prisma } from "@/lib/db";
import { drainInlineQueue, setInlineMode } from "@/lib/queue";
import { createBackupJob, resumeBackup } from "@/lib/services/salesforce/backups";

setInlineMode("manual");
const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

async function main() {
  const conn = await prisma.salesforceConnection.findFirst({ where: { kind: "LIVE", archivedAt: null }, include: { businessUnits: true } });
  if (!conn) throw new Error("No live Salesforce connection. Run npm run sfmc:connect first.");
  if (process.env.SFMC_RESUME) {
    const r = await prisma.salesforceBackupJob.findFirst({ where: { OR: [{ id: process.env.SFMC_RESUME }, { code: process.env.SFMC_RESUME }] } });
    if (!r) throw new Error(`Backup ${process.env.SFMC_RESUME} not found`);
    await resumeBackup(r.id, null);
    console.log(`resuming ${r.code}`);
    return drive(r.id);
  }
  const mids = list(process.env.SFMC_MIDS) ?? conn.businessUnits.filter((b) => b.selected).map((b) => b.mid);
  const dataTypes = list(process.env.SFMC_DATA_TYPES);
  if (!dataTypes?.length) throw new Error("Set SFMC_DATA_TYPES (see BACKUP_DATA_TYPES in src/lib/salesforce/objects.ts).");
  const admin = await prisma.user.findFirst({ where: { role: { key: "ADMIN" }, isActive: true, deletedAt: null }, orderBy: { createdAt: "asc" } });
  const actor = admin ? { id: admin.id, email: admin.email } : null;
  const day = (d: string | undefined, end: boolean) => (d ? new Date(`${d}T${end ? "23:59:59" : "00:00:00"}+05:30`).toISOString() : undefined);
  const job = await createBackupJob(
    {
      connectionId: conn.id,
      mids,
      dataTypes,
      deKeys: list(process.env.SFMC_DE_KEYS),
      jobIds: list(process.env.SFMC_JOB_IDS),
      dateFrom: day(process.env.SFMC_FROM, false),
      dateTo: day(process.env.SFMC_TO, true),
      mode: process.env.SFMC_MODE === "INCREMENTAL" ? "INCREMENTAL" : "FULL",
      refreshRecentDays: 14,
    },
    actor,
    { allowConcurrent: process.env.SFMC_ALLOW_CONCURRENT === "1" },
  );
  console.log(`backup ${job.code} started (MID ${mids.join(", ")}; ${dataTypes.join(", ")})`);
  return drive(job.id);
}

async function drive(jobId: string) {
  const job = { id: jobId };
  const t0 = Date.now();
  let ran = 0;
  for (;;) {
    const n = await drainInlineQueue(50);
    ran += n;
    const j = await prisma.salesforceBackupJob.findUniqueOrThrow({ where: { id: job.id }, include: { datasets: { select: { status: true, recordsExtracted: true } } } });
    const done = j.datasets.filter((d) => !["PENDING", "RUNNING"].includes(d.status)).length;
    process.stdout.write(`\r  ${done}/${j.datasets.length} datasets · ${j.datasets.reduce((a, d) => a + d.recordsExtracted, 0)} records · ${Math.round((Date.now() - t0) / 1000)}s   `);
    if (!n) break;
  }
  console.log(`\n(${ran} queue steps)`);
  const j = await prisma.salesforceBackupJob.findUniqueOrThrow({ where: { id: job.id }, include: { datasets: { orderBy: { createdAt: "asc" } } } });
  console.log(`\n${j.code}: ${j.status} · verification ${j.verificationStatus}`);
  for (const d of j.datasets) {
    const dropped = Object.entries((d.params as { droppedProperties?: Record<string, string[]> }).droppedProperties ?? {});
    console.log(`  ${d.status.padEnd(15)} ${d.verificationStatus.padEnd(19)} ${String(d.recordsExtracted).padStart(7)}  ${d.label}${dropped.length ? `  [dropped: ${dropped.map(([o, p]) => `${o}.${p.join("/")}`).join("; ")}]` : ""}${d.errorMessage ? `  — ${d.errorMessage.slice(0, 160)}` : ""}`);
  }
  for (const n of j.verificationNotes as string[]) console.log(`  note: ${n}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
