/**
 * Restore a Salesforce archive export (see scripts/sfmc-export.ts) into the database in
 * DATABASE_URL and the evidence store in ARCHIVE_STORAGE_DIR.
 *
 *   SFMC_IMPORT_DIR=D:\backups\salesforce-archive-20261019-1200 npm run sfmc:import
 *
 * Requirements: migrations applied (npx prisma migrate deploy); every salesforce_* table empty
 * (refuses otherwise). Verifies the manifest hash and every table file's SHA-256 before loading,
 * then checks row counts after loading.
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { prisma } from "@/lib/db";
import { archiveRoot } from "@/lib/salesforce/storage";

interface Manifest {
  exportFormat: string;
  tables: { table: string; rows: number; file: string; sha256: string }[];
  archiveStore: { path: string; files: number };
}

async function sha256File(file: string) {
  const h = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

async function main() {
  const dir = process.env.SFMC_IMPORT_DIR;
  if (!dir) throw new Error("Set SFMC_IMPORT_DIR to the export folder.");
  const manifestText = await fs.promises.readFile(path.join(dir, "export-manifest.json"), "utf8");
  const expected = (await fs.promises.readFile(path.join(dir, "export-manifest.sha256"), "utf8")).split(/\s+/)[0];
  if (createHash("sha256").update(manifestText).digest("hex") !== expected) throw new Error("export-manifest.json does not match its SHA-256 — the export has been altered or damaged.");
  const manifest = JSON.parse(manifestText) as Manifest;
  if (manifest.exportFormat !== "niveshaay-salesforce-archive/1") throw new Error(`Unsupported export format ${manifest.exportFormat}`);

  console.log("verifying table files…");
  for (const t of manifest.tables) {
    if ((await sha256File(path.join(dir, t.file))) !== t.sha256) throw new Error(`${t.file}: SHA-256 mismatch — file altered or damaged`);
  }
  for (const t of manifest.tables) {
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT COUNT(*)::int AS n FROM "${t.table}"`);
    if (n > 0) throw new Error(`Target table ${t.table} is not empty (${n} rows). Restore into a fresh database.`);
  }

  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "sfmc-import-"));
  try {
    // Load with triggers/constraints deferred (session_replication_role = replica) because the
    // immutability guards would otherwise reject restoring sealed evidence; integrity is checked
    // by the hashes above and the counts below.
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
        for (const t of manifest.tables) {
          const raw = path.join(tmp, `${t.table}.pgbin`);
          await pipeline(fs.createReadStream(path.join(dir, t.file)), createGunzip(), fs.createWriteStream(raw));
          await tx.$executeRawUnsafe(`COPY "${t.table}" FROM '${raw.replace(/\\/g, "/").replace(/'/g, "''")}' WITH (FORMAT binary)`);
          await fs.promises.rm(raw);
          console.log(`  loaded ${t.table} (${t.rows} rows)`);
        }
      },
      { timeout: 6 * 3_600_000, maxWait: 60_000 },
    );
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }

  // Bigint id sequences continue after the restored rows.
  for (const t of manifest.tables) {
    const [{ seq }] = await prisma.$queryRawUnsafe<{ seq: string | null }[]>(`SELECT pg_get_serial_sequence('"${t.table}"', 'id') AS seq`);
    if (seq) await prisma.$executeRawUnsafe(`SELECT setval('${seq}', COALESCE((SELECT MAX(id) FROM "${t.table}"), 1))`);
  }
  for (const t of manifest.tables) {
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT COUNT(*)::int AS n FROM "${t.table}"`);
    if (n !== t.rows) throw new Error(`${t.table}: restored ${n} rows, export has ${t.rows}`);
  }

  const target = archiveRoot();
  console.log(`restoring evidence store to ${target}…`);
  await fs.promises.mkdir(target, { recursive: true });
  await fs.promises.cp(path.join(dir, manifest.archiveStore.path), target, { recursive: true, force: false, errorOnExist: false });
  console.log(`\nRESTORED ${manifest.tables.reduce((a, t) => a + t.rows, 0).toLocaleString("en-IN")} rows in ${manifest.tables.length} tables; all hashes and counts verified.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
