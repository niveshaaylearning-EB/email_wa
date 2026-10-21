/**
 * Delivery status ordering. Provider events can arrive out of order or more than once;
 * a status may only move "forward". FAILED/BOUNCED are terminal unless a later positive
 * signal arrives (e.g. a WhatsApp READ after a spurious failure is still recorded as READ).
 *
 * ACCEPTED means the provider API accepted the request — it is NOT delivery.
 */
export type DeliveryStatusKey =
  | "PENDING"
  | "QUEUED"
  | "SUBMITTED"
  | "ACCEPTED"
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED"
  | "BOUNCED"
  | "CANCELLED"
  | "DRY_RUN";

const RANK: Record<DeliveryStatusKey, number> = {
  PENDING: 0,
  QUEUED: 1,
  SUBMITTED: 2,
  ACCEPTED: 3,
  SENT: 4,
  DELIVERED: 5,
  READ: 6,
  FAILED: 4.5, // after SENT (a sent message can still fail), but DELIVERED/READ supersede it
  BOUNCED: 4.5,
  CANCELLED: 10,
  DRY_RUN: 10,
};

export const TERMINAL_DELIVERY: DeliveryStatusKey[] = ["READ", "CANCELLED", "DRY_RUN"];

/** Returns true if moving from `current` to `next` should be applied. */
export function shouldAdvance(current: DeliveryStatusKey, next: DeliveryStatusKey): boolean {
  if (current === next) return false;
  if (current === "CANCELLED" || current === "DRY_RUN") return false;
  return RANK[next] > RANK[current];
}

export const TIMESTAMP_FIELD: Partial<Record<DeliveryStatusKey, string>> = {
  SUBMITTED: "submittedAt",
  ACCEPTED: "acceptedAt",
  SENT: "sentAt",
  DELIVERED: "deliveredAt",
  READ: "readAt",
  FAILED: "failedAt",
  BOUNCED: "failedAt",
};

export const DELIVERY_STATUS_LABEL: Record<DeliveryStatusKey, string> = {
  PENDING: "Pending",
  QUEUED: "Queued",
  SUBMITTED: "Submitted",
  ACCEPTED: "Provider accepted",
  SENT: "Sent",
  DELIVERED: "Delivered",
  READ: "Read",
  FAILED: "Failed",
  BOUNCED: "Bounced",
  CANCELLED: "Cancelled",
  DRY_RUN: "Dry run",
};

/** Retry classification for provider HTTP outcomes. */
export type RetryClass = "retryable" | "permanent" | "unconfirmed";

/**
 * - retryable: we know the provider did NOT process the request (connection refused, 429, 503, 502 before body)
 * - permanent: provider rejected it (4xx validation/auth)
 * - unconfirmed: request may have been processed (timeout after send, 500, network reset mid-flight).
 *   We never auto-retry these — a human reconciles them, to avoid duplicate client messages.
 */
export function classifyHttpOutcome(opts: { status?: number; networkError?: "before_send" | "after_send" }): RetryClass {
  if (opts.networkError === "before_send") return "retryable";
  if (opts.networkError === "after_send") return "unconfirmed";
  const s = opts.status ?? 0;
  if (s === 429 || s === 503 || s === 502) return "retryable";
  if (s >= 500) return "unconfirmed";
  if (s >= 400) return "permanent";
  return "permanent";
}

export function backoffMs(attempt: number, baseMs = 2000, maxMs = 5 * 60_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.min(1000, exp / 4));
  return exp + jitter;
}
