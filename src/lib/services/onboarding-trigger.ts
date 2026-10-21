/**
 * TEST MODULE — DoubleTick Bot Studio "On Webhook" trigger for the onboarding bot
 * (bot: onboarding_entity_type). Remove after testing: see docs/doubletick-onboarding-test.md.
 *
 * Contract (from DoubleTick, 2026-10-19):
 *   POST {DOUBLETICK_ONBOARDING_WEBHOOK_URL}
 *   Content-Type: application/json, Authorization: <key>
 *   { "customerPhone": "919XXXXXXXXX", "customerName": "Client Name" }
 *   Each valid call sends a REAL WhatsApp welcome message. No message ID is returned.
 *
 * Safety:
 *   - Real calls only to approved internal test recipients, unless ALLOW_LIVE_SEND=true AND
 *     DoubleTick is in LIVE mode (then clients with WhatsApp consent and no suppression).
 *   - Uses the trigger's own Authorization Key; never falls back to the main API key.
 *   - No automatic retries (a retry could send a second message); same number blocked for 10 minutes.
 *   - Every attempt (preview, sent, failed, blocked) is written to the audit log.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { sha256 } from "@/lib/crypto";
import { audit, type AuditActor } from "@/lib/audit";
import { badRequest, forbidden, notFound } from "@/lib/errors";
import { httpRequest, NetworkError } from "@/lib/providers/http";
import { ensureIntegration } from "./integrations";
import { activeSuppressionSet, currentConsents } from "./clients";
import { isApprovedRealSendNumber, SEND_LOCK_MESSAGE } from "@/lib/send-allowlist";

const URL_RE = /^https:\/\/bothook\.io\/v1\/public\/triggers\/webhooks\/[0-9a-f-]{36}$/i;
const DEDUPE_MINUTES = 10;
export const ONBOARDING_ACTION = "automation.onboarding_trigger";

/** Letters-only key so audit-log PII masking (which rewrites "phone" fields and digit runs) never alters it. */
function dedupeKeyFor(phoneE164: string) {
  return sha256(`onboarding:${phoneE164}`).replace(/[0-9]/g, (d) => "ghijklmnop"[Number(d)]);
}

export interface OnboardingTarget {
  kind: "test_recipient" | "client";
  id: string;
  name: string;
  phoneE164: string | null;
}

export function onboardingConfig() {
  const e = env();
  const url = e.DOUBLETICK_ONBOARDING_WEBHOOK_URL?.trim() || null;
  return {
    url,
    urlValid: !!url && URL_RE.test(url),
    triggerId: url?.split("/").pop() ?? null,
    hasAuthKey: !!e.DOUBLETICK_ONBOARDING_AUTH_KEY?.trim(),
    liveSendEnabled: e.ALLOW_LIVE_SEND,
  };
}

/** Payload exactly as DoubleTick specified: digits only, country code, no "+" or spaces. */
export function buildOnboardingPayload(t: { name: string; phoneE164: string }) {
  return { customerPhone: t.phoneE164.replace(/\D/g, ""), customerName: t.name.trim().slice(0, 100) };
}

async function resolveTarget(input: { testRecipientId?: string; clientId?: string }): Promise<OnboardingTarget> {
  if (input.testRecipientId) {
    const r = await prisma.internalTestRecipient.findUnique({ where: { id: input.testRecipientId } });
    if (!r || !r.isActive) throw notFound("Test recipient");
    return { kind: "test_recipient", id: r.id, name: r.name, phoneE164: r.phoneE164 };
  }
  if (input.clientId) {
    const c = await prisma.client.findUnique({ where: { id: input.clientId } });
    if (!c) throw notFound("Client");
    return { kind: "client", id: c.id, name: c.fullName, phoneE164: c.phoneValid ? c.phoneE164 : null };
  }
  throw badRequest("Choose a test recipient or a client.");
}

/** Reasons a real call is not allowed for this target (empty = allowed). */
async function realSendBlockers(t: OnboardingTarget): Promise<string[]> {
  const cfg = onboardingConfig();
  const reasons: string[] = [];
  if (!cfg.urlValid) reasons.push("Webhook URL is missing or not a bothook.io trigger URL (DOUBLETICK_ONBOARDING_WEBHOOK_URL).");
  if (!cfg.hasAuthKey) reasons.push("Trigger Authorization Key is not set (DOUBLETICK_ONBOARDING_AUTH_KEY).");
  if (!t.phoneE164) reasons.push("Recipient has no valid mobile number.");
  else if (!isApprovedRealSendNumber(t.phoneE164)) reasons.push(SEND_LOCK_MESSAGE);
  if (t.kind === "client") {
    const dt = await ensureIntegration("DOUBLETICK");
    if (!cfg.liveSendEnabled || dt.mode !== "LIVE") {
      reasons.push("Real clients are blocked during testing (needs ALLOW_LIVE_SEND=true and DoubleTick in LIVE mode). Use an internal test recipient.");
    } else {
      const consent = (await currentConsents([t.id])).get(t.id)?.WHATSAPP?.status;
      if (consent !== "GRANTED") reasons.push("Client has no WhatsApp opt-in consent.");
      if (t.phoneE164 && (await activeSuppressionSet([t.phoneE164])).size) reasons.push("Client's number is on the suppression list.");
    }
  }
  if (t.phoneE164) {
    const key = dedupeKeyFor(t.phoneE164);
    const recent = await prisma.auditLog.findFirst({
      where: { action: ONBOARDING_ACTION, createdAt: { gt: new Date(Date.now() - DEDUPE_MINUTES * 60_000) }, metadata: { path: ["dedupeKey"], equals: key } },
      orderBy: { createdAt: "desc" },
    });
    if (recent && (recent.metadata as { outcome?: string }).outcome === "sent") {
      reasons.push(`A real message was already triggered for this number in the last ${DEDUPE_MINUTES} minutes.`);
    }
  }
  return reasons;
}

export interface TriggerResult {
  outcome: "preview" | "sent" | "failed" | "blocked";
  target: { kind: OnboardingTarget["kind"]; name: string; phoneE164: string | null };
  payload: { customerPhone: string; customerName: string } | null;
  blockers: string[];
  httpStatus?: number;
  providerResponse?: string;
  error?: string;
}

export async function triggerOnboarding(
  input: { testRecipientId?: string; clientId?: string; dryRun: boolean; confirm?: string },
  actor: AuditActor,
): Promise<TriggerResult> {
  const t = await resolveTarget(input);
  const payload = t.phoneE164 ? buildOnboardingPayload({ name: t.name, phoneE164: t.phoneE164 }) : null;
  const blockers = await realSendBlockers(t);
  const base = { target: { kind: t.kind, name: t.name, phoneE164: t.phoneE164 }, payload, blockers };
  const log = (outcome: TriggerResult["outcome"], extra: Record<string, unknown> = {}) =>
    audit({
      actor,
      action: ONBOARDING_ACTION,
      entityType: t.kind === "client" ? "client" : "test_recipient",
      entityId: t.id,
      metadata: { outcome, triggerId: onboardingConfig().triggerId, dedupeKey: t.phoneE164 ? dedupeKeyFor(t.phoneE164) : null, phone: t.phoneE164, ...extra },
    });

  if (input.dryRun) {
    await log("preview", { blockers });
    return { outcome: "preview", ...base };
  }
  if (input.confirm !== "SEND") throw badRequest('Type SEND to confirm a real WhatsApp message.');
  if (blockers.length) {
    await log("blocked", { blockers });
    throw forbidden(blockers.join(" "));
  }

  const cfg = onboardingConfig();
  let res;
  try {
    res = await httpRequest(cfg.url!, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: env().DOUBLETICK_ONBOARDING_AUTH_KEY!.trim() },
      body: JSON.stringify(payload),
      timeoutMs: 20_000,
    });
  } catch (err) {
    const phase = err instanceof NetworkError ? err.phase : "after_send";
    const error = phase === "before_send" ? `Could not reach DoubleTick: ${(err as Error).message}` : `No response from DoubleTick (${(err as Error).message}). The message MAY have been sent — check the test phone before retrying.`;
    await log("failed", { error, phase });
    return { outcome: "failed", ...base, error };
  }
  const providerResponse = res.text.slice(0, 500);
  if (!res.ok) {
    const error = res.status === 401 || res.status === 403 ? "DoubleTick rejected the Authorization key." : `DoubleTick returned HTTP ${res.status}.`;
    await log("failed", { httpStatus: res.status, providerResponse, error });
    return { outcome: "failed", ...base, httpStatus: res.status, providerResponse, error };
  }
  await log("sent", { httpStatus: res.status, providerResponse });
  return { outcome: "sent", ...base, httpStatus: res.status, providerResponse };
}

export async function recentOnboardingRuns(limit = 30) {
  return prisma.auditLog.findMany({ where: { action: ONBOARDING_ACTION }, orderBy: { createdAt: "desc" }, take: limit });
}

