/**
 * Export the complete Salesforce archive into ONE portable folder:
 *
 *   tables/<table>.pgbin.gz   every salesforce_* table, PostgreSQL binary COPY format (exact
 *                             types and values), gzip-compressed, SHA-256 fingerprinted
 *   archive-store/            the encrypted evidence store (raw Salesforce responses, email
 *                             content, images/PDFs, manifests) — copied as-is
 *   schema/                   prisma schema + migrations needed to recreate the tables
 *   export-manifest.json      row counts, hashes, versions; README.txt — restore steps
 *
 *   npm run sfmc:export                      (default: ~/.niveshaay-cc/exports/salesforce-archive-<date>)
 *   SFMC_EXPORT_DIR=D:\backups\sfmc npm run sfmc:export
 *
 * The encryption key (ARCHIVE_ENCRYPTION_KEY / CREDENTIALS_ENCRYPTION_KEY in .env) is NOT
 * included — store it separately. Read-only towards the database (COPY TO).
 */
import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { prisma } from "@/lib/db";
import { archiveRoot } from "@/lib/salesforce/storage";

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/^(\d{8})(\d{4})$/, "$1-$2");
const outDir = path.resolve(process.env.SFMC_EXPORT_DIR || path.join(os.homedir(), ".niveshaay-cc", "exports", `salesforce-archive-${stamp}`));

function hasher() {
  const h = createHash("sha256");
  let bytes = 0;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      h.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  return { t, digest: () => h.digest("hex"), bytes: () => bytes };
}

async function dirStats(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) {
      files += 1;
      bytes += (await fs.promises.stat(path.join(e.parentPath, e.name))).size;
    }
  }
  return { files, bytes };
}

async function main() {
  if (fs.existsSync(outDir) && (await fs.promises.readdir(outDir)).length) throw new Error(`Export folder already exists and is not empty: ${outDir}`);
  await fs.promises.mkdir(path.join(outDir, "tables"), { recursive: true });
  console.log(`exporting to ${outDir}`);

  const tables = (await prisma.$queryRawUnsafe<{ t: string }[]>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'salesforce\\_%' ORDER BY tablename")).map((r) => r.t);
  const [{ v }] = await prisma.$queryRawUnsafe<{ v: string }[]>("SELECT current_setting('server_version') AS v");
  const [{ enc }] = await prisma.$queryRawUnsafe<{ enc: string }[]>("SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = current_database()");
  const migrations = (await prisma.$queryRawUnsafe<{ migration_name: string }[]>("SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at")).map((m) => m.migration_name);

  const tableInfo: { table: string; rows: number; file: string; sha256: string; bytes: number; rawBytes: number }[] = [];
  for (const t of tables) {
    const rawFile = path.join(outDir, "tables", `${t}.pgbin`);
    const t0 = Date.now();
    // Server-side COPY: the local PostgreSQL server writes the file directly (fast, exact).
    await prisma.$executeRawUnsafe(`COPY "${t}" TO '${rawFile.replace(/\\/g, "/").replace(/'/g, "''")}' WITH (FORMAT binary)`);
    const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT COUNT(*)::int AS n FROM "${t}"`);
    const gzFile = `${rawFile}.gz`;
    const raw = hasher();
    const gz = hasher();
    await pipeline(fs.createReadStream(rawFile), raw.t, createGzip({ level: 6 }), gz.t, fs.createWriteStream(gzFile));
    await fs.promises.rm(rawFile);
    tableInfo.push({ table: t, rows: n, file: `tables/${t}.pgbin.gz`, sha256: gz.digest(), bytes: gz.bytes(), rawBytes: raw.bytes() });
    console.log(`  ${t.padEnd(36)} ${String(n).padStart(10)} rows  ${(gz.bytes() / 1e6).toFixed(1).padStart(8)} MB  ${Math.round((Date.now() - t0) / 1000)}s`);
  }

  console.log("copying encrypted evidence store…");
  const store = archiveRoot();
  await fs.promises.cp(store, path.join(outDir, "archive-store"), { recursive: true, errorOnExist: true, force: false });
  const storeStats = await dirStats(path.join(outDir, "archive-store"));

  const repo = process.cwd();
  await fs.promises.mkdir(path.join(outDir, "schema"), { recursive: true });
  await fs.promises.cp(path.join(repo, "prisma", "migrations"), path.join(outDir, "schema", "migrations"), { recursive: true });
  await fs.promises.copyFile(path.join(repo, "prisma", "schema.prisma"), path.join(outDir, "schema", "schema.prisma"));

  const conn = await prisma.salesforceConnection.findFirst({ where: { kind: "LIVE", archivedAt: null }, select: { name: true, enterpriseMid: true, authBaseUri: true } });
  const manifest = {
    exportFormat: "niveshaay-salesforce-archive/1",
    createdAt: new Date().toISOString(),
    createdOn: os.hostname(),
    source: { system: "Salesforce Marketing Cloud Engagement", connection: conn?.name ?? null, enterpriseMid: conn?.enterpriseMid ?? null, authHost: conn?.authBaseUri ? new URL(conn.authBaseUri).host : null },
    database: { postgresVersion: v, encoding: enc, migrations },
    tables: tableInfo,
    archiveStore: { path: "archive-store", ...storeStats, encrypted: "AES-256-GCM (key NOT included — see README)" },
    totals: { rows: tableInfo.reduce((a, t) => a + t.rows, 0), compressedBytes: tableInfo.reduce((a, t) => a + t.bytes, 0) + storeStats.bytes },
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  await fs.promises.writeFile(path.join(outDir, "export-manifest.json"), manifestText);
  await fs.promises.writeFile(path.join(outDir, "export-manifest.sha256"), `${createHash("sha256").update(manifestText).digest("hex")}  export-manifest.json\n`);
  await fs.promises.writeFile(
    path.join(outDir, "README.txt"),
    [
      "NIVESHAAY — SALESFORCE MARKETING CLOUD ARCHIVE EXPORT",
      `Created ${manifest.createdAt} on ${manifest.createdOn}. ${manifest.totals.rows.toLocaleString("en-IN")} rows in ${tableInfo.length} tables, plus ${storeStats.files.toLocaleString("en-IN")} evidence files.`,
      "",
      "Contains client personal data. Store on encrypted, access-controlled storage.",
      "",
      "THE ENCRYPTION KEY IS NOT IN THIS FOLDER.",
      "Evidence files in archive-store/ are AES-256-GCM encrypted. To read them you need the",
      "ARCHIVE_ENCRYPTION_KEY (or, if unset, CREDENTIALS_ENCRYPTION_KEY) value from the .env file",
      "of the Niveshaay Communication Center that created this export. Keep a copy of that key in a",
      "separate secure place (e.g. the company password manager). Without it the evidence files",
      "cannot be decrypted; the tables remain readable.",
      "",
      "INTEGRITY",
      "  Each tables/*.pgbin.gz has its SHA-256 in export-manifest.json; the manifest's own SHA-256 is",
      "  in export-manifest.sha256. The import script verifies all of them.",
      "",
      "RESTORE (into the Niveshaay Communication Center, PostgreSQL " + v.split(" ")[0] + "+, UTF8 database)",
      "  1. Create an empty UTF8 database and point DATABASE_URL at it.",
      "  2. npx prisma migrate deploy          (creates the tables; same migrations as schema/migrations)",
      "  3. Put the original key in .env (CREDENTIALS_ENCRYPTION_KEY / ARCHIVE_ENCRYPTION_KEY).",
      "  4. SFMC_IMPORT_DIR=<this folder> npm run sfmc:import",
      "     (verifies hashes, loads every table, restores the evidence store to ARCHIVE_STORAGE_DIR,",
      "      checks row counts)",
      "",
      "The .pgbin files are PostgreSQL binary COPY files: COPY <table> FROM '<file>' WITH (FORMAT binary).",
      "",
    ].join("\r\n"),
  );
  console.log(`\nDONE ${outDir}\n  ${manifest.totals.rows.toLocaleString("en-IN")} rows · ${(manifest.totals.compressedBytes / 1e9).toFixed(2)} GB total`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
