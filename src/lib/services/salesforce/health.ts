import "server-only";
import { prisma } from "@/lib/db";

let cached: string | null = null;

/** Server encoding of the current database. Archived Salesforce data needs UTF8. */
export async function databaseEncoding(): Promise<string> {
  if (cached) return cached;
  const r = await prisma.$queryRaw<{ enc: string }[]>`SELECT pg_encoding_to_char(encoding) AS enc FROM pg_database WHERE datname = current_database()`;
  cached = r[0]?.enc ?? "UNKNOWN";
  return cached;
}

export async function archiveHealth() {
  const encoding = await databaseEncoding();
  return {
    encoding,
    encodingOk: encoding === "UTF8",
    encodingMessage:
      encoding === "UTF8"
        ? null
        : `This database uses ${encoding}, which cannot store every Unicode character (₹, Devanagari, emoji). Live Salesforce backups are blocked until the database is recreated as UTF8 — see docs/salesforce-archive.md, "Database encoding".`,
  };
}
