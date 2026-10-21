import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { maskDeep } from "@/lib/mask";
import { enqueue } from "@/lib/queue";
import {
  parseDoubleTickStatusPayload,
  statusEventDedupeKey,
  verifyDoubleTickAuth,
  type DoubleTickStatusEvent,
} from "@/lib/providers/doubletick/webhook";
import { loadIntegration } from "./integrations";
import { applyDeliveryStatus } from "./delivery-events";
import { checkCompletion } from "./execution";

const STATUS_MAP = { SENT: "SENT", DELIVERED: "DELIVERED", READ: "READ", FAILED: "FAILED" } as const;

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Entry point for POST /api/webhooks/doubletick/status.
 * 1. authenticate (Bearer secret configured at webhook registration; constant-time compare)
 * 2. persist each event once (unique dedupe key → duplicates are acknowledged, not re-applied)
 * 3. apply forward-only status transitions
 * Always 2xx for authenticated, well-formed requests so the provider doesn't retry storms;
 * events that can't be matched yet are retried internally (provider callback may beat our DB write).
 */
export async function handleDoubleTickStatusWebhook(rawBody: string, headers: Headers): Promise<WebhookResult> {
  const { secrets } = await loadIntegration("DOUBLETICK");
  const authOk = verifyDoubleTickAuth(headers.get("authorization"), secrets.webhookSecret);
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = null;
  }
  if (!authOk) {
    await prisma.webhookEvent.create({
      data: {
        provider: "DOUBLETICK",
        dedupeKey: `rejected:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        signatureValid: false,
        status: "REJECTED",
        headers: maskDeep(Object.fromEntries(headers)) as Prisma.InputJsonValue,
        payload: (maskDeep(payload) ?? {}) as Prisma.InputJsonValue,
        error: "Authorization header missing or invalid",
      },
    });
    return { status: 401, body: { error: "unauthorized" } };
  }
  if (payload === null) return { status: 400, body: { error: "invalid JSON" } };

  const { events, invalid } = parseDoubleTickStatusPayload(payload);
  let processed = 0;
  let duplicates = 0;
  for (const e of events) {
    const r = await ingestStatusEvent(e, headers);
    if (r === "duplicate") duplicates++;
    else processed++;
  }
  return { status: 200, body: { received: events.length, processed, duplicates, invalid } };
}

async function ingestStatusEvent(e: DoubleTickStatusEvent, headers?: Headers): Promise<"duplicate" | "stored"> {
  const dedupeKey = statusEventDedupeKey(e);
  try {
    const row = await prisma.webhookEvent.create({
      data: {
        provider: "DOUBLETICK",
        dedupeKey,
        signatureValid: true,
        headers: (headers ? maskDeep(Object.fromEntries(headers)) : {}) as Prisma.InputJsonValue,
        // `match` keeps the non-PII fields needed to re-process the event; the rest is PII-masked.
        payload: {
          match: { messageId: e.messageId, status: e.status, statusTimestamp: e.statusTimestamp, errorCode: e.errorCode, failMessage: e.failMessage, nccDeliveryId: e.nccDeliveryId },
          masked: maskDeep(e),
        } as Prisma.InputJsonValue,
      },
    });
    await processWebhookEventRow(row.id, e);
    return "stored";
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") {
      await prisma.webhookEvent.updateMany({ where: { dedupeKey }, data: { attempts: { increment: 1 } } });
      return "duplicate";
    }
    throw err;
  }
}

async function processWebhookEventRow(rowId: string, e: DoubleTickStatusEvent) {
  const outcome = await processStatusEvent(e, { simulated: false });
  if (outcome === "unmatched") {
    const row = await prisma.webhookEvent.update({ where: { id: rowId }, data: { attempts: { increment: 1 }, error: "No delivery with this messageId yet" } });
    if (row.attempts < 6) {
      await enqueue("webhook.retry", { webhookEventId: rowId }, { delayMs: 15_000 * row.attempts, jobId: `wh:${rowId}:${row.attempts}` });
    } else {
      await prisma.webhookEvent.update({ where: { id: rowId }, data: { status: "IGNORED", processedAt: new Date(), error: "No matching delivery after retries" } });
    }
    return;
  }
  await prisma.webhookEvent.update({ where: { id: rowId }, data: { status: "PROCESSED", processedAt: new Date(), error: null } });
}

/** Re-attempt matching for an event whose delivery row wasn't found yet. */
export async function retryWebhookEvent(webhookEventId: string) {
  const row = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!row || row.status !== "RECEIVED") return;
  const e = (row.payload as unknown as { match: DoubleTickStatusEvent }).match;
  if (!e?.messageId) return;
  await processWebhookEventRow(row.id, e);
}

/**
 * Apply one status event. Shared by the real webhook and the MOCK simulator (which passes
 * simulated=true so events are attributed to SIMULATION, never to the provider).
 */
export async function processStatusEvent(e: DoubleTickStatusEvent, opts: { simulated: boolean }): Promise<"applied" | "noop" | "unmatched"> {
  let delivery = await prisma.messageDelivery.findUnique({ where: { providerMessageId: e.messageId } });
  if (!delivery && typeof e.nccDeliveryId === "string") {
    delivery = await prisma.messageDelivery.findUnique({ where: { id: e.nccDeliveryId } });
  }
  if (!delivery) return "unmatched";
  const toStatus = STATUS_MAP[e.status];
  const occurredAt = e.statusTimestamp ? new Date(e.statusTimestamp) : new Date();
  const r = await applyDeliveryStatus(delivery.id, {
    toStatus,
    source: opts.simulated ? "SIMULATION" : "WEBHOOK",
    occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
    providerMessageId: e.messageId,
    failureCode: toStatus === "FAILED" ? (e.errorCode !== undefined ? String(e.errorCode) : "PROVIDER_FAILED") : undefined,
    failureReason: toStatus === "FAILED" ? e.failMessage ?? "Provider reported failure" : undefined,
    detail: { providerStatus: e.status },
  });
  if (toStatus === "FAILED" || r.advanced) await checkCompletion(delivery.campaignId);
  return r.advanced ? "applied" : "noop";
}
