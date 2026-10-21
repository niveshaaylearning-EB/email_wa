import "server-only";
import { prisma, type Db } from "@/lib/db";
import { maskDeep } from "@/lib/mask";
import type { Prisma } from "@prisma/client";

export interface AuditActor {
  id: string;
  email: string;
}

export interface AuditEntry {
  actor?: AuditActor | null;
  action: string; // e.g. "campaign.approved"
  entityType: string;
  entityId?: string | null;
  campaignId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
}

/** Append an audit record. Metadata is PII-masked before persistence. */
export async function audit(entry: AuditEntry, db: Db = prisma) {
  await db.auditLog.create({
    data: {
      actorId: entry.actor?.id ?? null,
      actorEmail: entry.actor?.email ?? "system",
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      campaignId: entry.campaignId ?? null,
      metadata: maskDeep(entry.metadata ?? {}) as Prisma.InputJsonValue,
      ipAddress: entry.ip,
      userAgent: entry.userAgent?.slice(0, 300),
    },
  });
}
