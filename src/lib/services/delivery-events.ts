import "server-only";
import type { DeliveryEventSource, DeliveryStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { shouldAdvance, TIMESTAMP_FIELD } from "@/lib/domain/delivery-status";
import { maskDeep } from "@/lib/mask";

export interface StatusUpdate {
  toStatus: DeliveryStatus;
  source: DeliveryEventSource;
  occurredAt?: Date;
  detail?: Record<string, unknown>;
  failureCode?: string | null;
  failureReason?: string | null;
  providerMessageId?: string;
}

/**
 * Applies a status transition if it moves the delivery forward. Uses an optimistic
 * compare-and-set on the current status so concurrent webhooks cannot regress state.
 * Every *received* event is recorded in delivery_events, even if it does not advance status.
 */
export async function applyDeliveryStatus(deliveryId: string, u: StatusUpdate): Promise<{ advanced: boolean; from: DeliveryStatus | null }> {
  const occurredAt = u.occurredAt ?? new Date();
  for (let attempt = 0; attempt < 3; attempt++) {
    const d = await prisma.messageDelivery.findUnique({ where: { id: deliveryId } });
    if (!d) return { advanced: false, from: null };
    const advance = shouldAdvance(d.status, u.toStatus);
    const data: Prisma.MessageDeliveryUpdateManyMutationInput = {};
    if (advance) data.status = u.toStatus;
    const tsField = TIMESTAMP_FIELD[u.toStatus];
    if (tsField && !(d as Record<string, unknown>)[tsField]) (data as Record<string, unknown>)[tsField] = occurredAt;
    // READ implies DELIVERED and SENT; DELIVERED implies SENT.
    if (u.toStatus === "READ") {
      if (!d.deliveredAt) data.deliveredAt = occurredAt;
      if (!d.sentAt) data.sentAt = occurredAt;
    }
    if (u.toStatus === "DELIVERED" && !d.sentAt) data.sentAt = occurredAt;
    if ((u.toStatus === "FAILED" || u.toStatus === "BOUNCED") && advance) {
      data.failureCode = u.failureCode ?? d.failureCode;
      data.failureReason = u.failureReason ?? d.failureReason;
    }
    if (u.providerMessageId && !d.providerMessageId) data.providerMessageId = u.providerMessageId;

    const res = Object.keys(data).length
      ? await prisma.messageDelivery.updateMany({ where: { id: d.id, status: d.status }, data })
      : { count: 1 };
    if (res.count === 0) continue; // raced with another update; re-read and retry
    await prisma.deliveryEvent.create({
      data: {
        deliveryId: d.id,
        source: u.source,
        fromStatus: d.status,
        toStatus: u.toStatus,
        detail: maskDeep({ ...(u.detail ?? {}), applied: advance }) as Prisma.InputJsonValue,
        occurredAt,
      },
    });
    return { advanced: advance, from: d.status };
  }
  return { advanced: false, from: null };
}

/** Email engagement (opens/clicks) are timestamps, not lifecycle statuses. */
export async function recordEngagement(deliveryId: string, kind: "opened" | "clicked", at: Date, source: DeliveryEventSource) {
  const d = await prisma.messageDelivery.findUnique({ where: { id: deliveryId } });
  if (!d) return;
  const field = kind === "opened" ? "openedAt" : "clickedAt";
  if (d[field]) return;
  await prisma.messageDelivery.update({ where: { id: deliveryId }, data: { [field]: at, ...(kind === "clicked" && !d.openedAt ? { openedAt: at } : {}) } });
  await prisma.deliveryEvent.create({ data: { deliveryId, source, fromStatus: d.status, toStatus: d.status, detail: { engagement: kind }, occurredAt: at } });
}
