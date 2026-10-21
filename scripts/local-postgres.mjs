// Local development PostgreSQL (no Docker required). Data lives OUTSIDE the OneDrive-synced
// project folder to avoid sync corruption. Usage: npm run db:start  (Ctrl+C to stop)
import EmbeddedPostgres from "embedded-postgres";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const port = Number(process.env.LOCAL_PG_PORT ?? 5433);
const dir = process.env.LOCAL_PG_DIR ?? path.join(os.homedir(), ".niveshaay-cc", `pgdata-${port}`);
const dbs = (process.env.LOCAL_PG_DATABASES ?? "niveshaay_cc,niveshaay_cc_test").split(",");
const fresh = !fs.existsSync(path.join(dir, "PG_VERSION"));

// UTF-8 is required: on Windows initdb otherwise inherits the ANSI code page (WIN1252), which
// cannot store ₹, Devanagari or emoji (client names, archived Salesforce data).
const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port, persistent: true, onLog: () => {}, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
if (fresh) await pg.initialise();
await pg.start();
const admin = pg.getPgClient();
await admin.connect();
for (const db of dbs) {
  const existing = await admin.query("SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = $1", [db]);
  if (!existing.rows.length) {
    await admin.query(`CREATE DATABASE "${db.replace(/"/g, "")}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
    console.log(`created database ${db} (UTF8)`);
  } else if (existing.rows[0].enc !== "UTF8") {
    console.warn(`WARNING: database ${db} uses ${existing.rows[0].enc}, not UTF8 — Unicode text (₹, Devanagari, emoji) will fail to save. See docs/salesforce-archive.md, "Database encoding".`);
  }
}
await admin.end();
console.log(`PostgreSQL ready on postgresql://postgres:postgres@localhost:${port} (data: ${dir})`);
const stop = async () => { await pg.stop(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
