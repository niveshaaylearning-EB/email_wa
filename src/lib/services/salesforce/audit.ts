import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma, type Db } from "@/lib/db";
import { maskDeep } from "@/lib/mask";

export interface ArchiveActor {
  id: string;
  email: string;
}

/**
 * Append to the Salesforce archive audit log (append-only, enforced by a DB trigger).
 * Records who accessed or exported archived evidence. Metadata is PII-masked.
 */
export async function archiveAudit(
  entry: { actor: ArchiveActor | null; action: string; entityType: string; entityId?: string | null; metadata?: Record<string, unknown>; ip?: string; userAgent?: string },
  db: Db = prisma,
) {
  await db.salesforceArchiveAuditLog.create({
    data: {
      actorId: entry.actor?.id ?? null,
      actorEmail: entry.actor?.email ?? "system",
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: maskArchiveMetadata(entry.metadata ?? {}) as Prisma.InputJsonValue,
      ipAddress: entry.ip,
      userAgent: entry.userAgent?.slice(0, 300),
    },
  });
}

/**
 * PII-mask audit metadata, but keep archive identifiers readable: backup/reconciliation/package
 * codes, MIDs and JobIDs look like phone numbers to the generic masker and would be scrambled.
 */
const IDENTIFIER_KEYS = new Set(["code", "mids", "mid", "jobIds", "jobId", "datasetId", "audienceDatasetId", "status", "kind", "mode", "label"]);
const IDENTIFIER_VALUE = /^(BKP|REC|EVP)-\d{8}-[0-9A-F]{6}$|^\d{1,15}$/;
function maskArchiveMetadata(metadata: Record<string, unknown>) {
  const masked = maskDeep(metadata) as Record<string, unknown>;
  for (const k of Object.keys(metadata)) {
    if (!IDENTIFIER_KEYS.has(k)) continue;
    const v = metadata[k];
    const safe = (x: unknown) => typeof x === "string" && (IDENTIFIER_VALUE.test(x) || !/\d{6,}/.test(x));
    if (safe(v) || (Array.isArray(v) && v.every(safe))) masked[k] = v;
  }
  return masked;
}

export async function extractionLog(entry: { backupJobId?: string | null; datasetId?: string | null; level: "info" | "warn" | "error"; message: string; data?: Record<string, unknown> }) {
  await prisma.salesforceExtractionLog.create({
    data: {
      backupJobId: entry.backupJobId ?? null,
      datasetId: entry.datasetId ?? null,
      level: entry.level,
      message: entry.message.slice(0, 2000),
      data: maskDeep(entry.data ?? {}) as Prisma.InputJsonValue,
    },
  });
}

/** Short human-friendly codes: BKP-20261016-7F3A2C */
export function archiveCode(prefix: "BKP" | "REC" | "EVP"): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `${prefix}-${ymd}-${Math.random().toString(16).slice(2, 8).toUpperCase().padEnd(6, "0")}`;
}
