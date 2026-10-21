/**
 * DoubleTick webhook verification & parsing.
 *
 * Authenticity: DoubleTick documents NO payload signature/HMAC. The supported mechanism is the
 * `authorization` ({type: BEARER, payload}) or custom `headers` configured when registering the
 * webhook (POST /v2/webhook/register), which DoubleTick sends with every delivery. We require
 * `Authorization: Bearer <DOUBLETICK_WEBHOOK_SECRET>` and compare in constant time.
 *
 * Payload (MESSAGE_STATUS_UPDATE): { messageId, to, status: SENT|DELIVERED|READ|FAILED,
 * statusTimestamp, failMessage?, ...customData spread at root }. There is no event-type field,
 * so status events are registered on their own URL (/api/webhooks/doubletick/status).
 */
import { z } from "zod";
import { safeEqual, sha256 } from "@/lib/crypto";

export function verifyDoubleTickAuth(authorizationHeader: string | null, secret: string | undefined): boolean {
  if (!secret || !authorizationHeader) return false;
  const value = authorizationHeader.trim();
  const token = value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : value;
  return safeEqual(token, secret);
}

export const DoubleTickStatusEventSchema = z
  .object({
    messageId: z.string().min(1),
    to: z.string().optional(),
    status: z.enum(["SENT", "DELIVERED", "READ", "FAILED"]),
    statusTimestamp: z.string().optional(),
    failMessage: z.string().optional(),
    errorCode: z.union([z.string(), z.number()]).optional(),
    nccDeliveryId: z.string().optional(),
  })
  .passthrough();
export type DoubleTickStatusEvent = z.infer<typeof DoubleTickStatusEventSchema>;

/** Accepts a single event or an array (defensive: batching is not documented). */
export function parseDoubleTickStatusPayload(payload: unknown): { events: DoubleTickStatusEvent[]; invalid: number } {
  const items = Array.isArray(payload) ? payload : [payload];
  const events: DoubleTickStatusEvent[] = [];
  let invalid = 0;
  for (const item of items) {
    const parsed = DoubleTickStatusEventSchema.safeParse(item);
    if (parsed.success) events.push(parsed.data);
    else invalid += 1;
  }
  return { events, invalid };
}

/** Duplicate deliveries of the same (message, status, timestamp) share one key. */
export function statusEventDedupeKey(e: DoubleTickStatusEvent): string {
  return `doubletick:${sha256(`${e.messageId}|${e.status}|${e.statusTimestamp ?? ""}`)}`;
}
