/**
 * Campaign orchestration (runs in the background worker — never from the browser).
 *
 * Safety model:
 *   - A campaign's liveness is fixed at approval (`campaign.isLive`). A campaign approved as
 *     non-live can NEVER send real messages, even if an integration is later switched to LIVE.
 *   - A live campaign whose provider is no longer LIVE is paused (fail-safe), not downgraded silently.
 *   - Each delivery is claimed with a conditional UPDATE before any provider call → no double sends.
 *   - Ambiguous provider outcomes (timeouts after send, HTTP 5xx) are NOT retried automatically.
 */
import "server-only";
import type { Channel, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { enqueue } from "@/lib/queue";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { classifyHttpOutcome, backoffMs } from "@/lib/domain/delivery-status";
import { getEmailProvider, getWhatsAppProvider } from "@/lib/providers/registry";
import { loadIntegration } from "./integrations";
import { getAppSettings, inQuietHours } from "./settings";
import { applyDeliveryStatus, recordEngagement } from "./delivery-events";
import { addSuppression, recordConsent } from "./clients";
import type { DoubleTickTemplateContent } from "@/lib/domain/template-render";

const MAX_WA_ATTEMPTS = 5;

type EffectiveMode = "LIVE" | "MOCK" | "DRY_RUN" | "BLOCKED";

export async function effectiveMode(channel: Channel, campaignIsLive: boolean): Promise<EffectiveMode> {
  const integ = await loadIntegration(channel === "EMAIL" ? "ZOHO_MA" : "DOUBLETICK");
  if (campaignIsLive) return integ.mode === "LIVE" && env().ALLOW_LIVE_SEND ? "LIVE" : "BLOCKED";
  return integ.mode === "MOCK" ? "MOCK" : "DRY_RUN";
}

interface EmailGroup {
  categoryId: string;
  templateId: string;
  contentToken: string;
  listKey?: string;
  campaignKey?: string;
  status?: "pending" | "list_synced" | "sent" | "failed" | "dry_run";
  expected?: number;
  verifiedCount?: number | null;
  error?: string;
  report?: Record<string, unknown>;
  reportAt?: string;
  simulated?: boolean;
}

function groupsOf(refs: Prisma.JsonValue): EmailGroup[] {
  return ((refs as { emailGroups?: EmailGroup[] })?.emailGroups ?? []) as EmailGroup[];
}

async function saveGroup(campaignId: string, idx: number, patch: Partial<EmailGroup>) {
  await prisma.$transaction(async (tx) => {
    const c = await tx.campaign.findUniqueOrThrow({ where: { id: campaignId }, select: { providerRefs: true } });
    const refs = (c.providerRefs ?? {}) as { emailGroups?: EmailGroup[] };
    const groups = refs.emailGroups ?? [];
    groups[idx] = { ...groups[idx], ...patch };
    await tx.campaign.update({ where: { id: campaignId }, data: { providerRefs: { ...refs, emailGroups: groups } as unknown as Prisma.InputJsonValue } });
  });
}

// ─── campaign.execute ────────────────────────────────────────────────

export async function executeCampaign(campaignId: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return;
  if (!["QUEUED", "RUNNING"].includes(campaign.status)) return; // paused/cancelled/etc.

  const settings = await getAppSettings();
  if (campaign.isLive && inQuietHours(settings)) {
    await audit({ action: "campaign.deferred_quiet_hours", entityType: "campaign", entityId: campaignId, campaignId });
    await enqueue("campaign.execute", { campaignId }, { delayMs: 15 * 60_000, jobId: `execute:${campaignId}:quiet:${Math.floor(Date.now() / 900_000)}` });
    return;
  }

  const channels: Channel[] = campaign.channelMode === "BOTH" ? ["EMAIL", "WHATSAPP"] : [campaign.channelMode];
  const modes = Object.fromEntries(await Promise.all(channels.map(async (ch) => [ch, await effectiveMode(ch, campaign.isLive)] as const))) as Record<Channel, EffectiveMode>;
  if (Object.values(modes).includes("BLOCKED")) {
    await prisma.campaign.update({ where: { id: campaignId }, data: { status: "PAUSED", pausedAt: new Date(), failureReason: "Paused automatically: a provider is no longer in LIVE mode (or ALLOW_LIVE_SEND is off). Review integrations, then resume." } });
    await audit({ action: "campaign.auto_paused", entityType: "campaign", entityId: campaignId, campaignId, metadata: { modes } });
    return;
  }

  if (campaign.status === "QUEUED") {
    const r = await prisma.campaign.updateMany({ where: { id: campaignId, status: "QUEUED" }, data: { status: "RUNNING", startedAt: campaign.startedAt ?? new Date() } });
    if (r.count === 0) return;
    await audit({ action: "campaign.execution_started", entityType: "campaign", entityId: campaignId, campaignId, metadata: { modes, isLive: campaign.isLive } });
  }

  // Materialise one delivery per planned assignment (idempotent via unique assignment_id).
  const assignments = await prisma.campaignMessageAssignment.findMany({
    where: { campaignId, status: "PLANNED", delivery: null },
    select: { id: true, channel: true, recipient: { select: { clientId: true } } },
  });
  for (let i = 0; i < assignments.length; i += 5000) {
    await prisma.messageDelivery.createMany({
      skipDuplicates: true,
      data: assignments.slice(i, i + 5000).map((a) => {
        const mode = modes[a.channel];
        return {
          assignmentId: a.id,
          campaignId,
          clientId: a.recipient.clientId,
          channel: a.channel,
          provider: a.channel === "EMAIL" ? ("ZOHO_MA" as const) : ("DOUBLETICK" as const),
          status: mode === "DRY_RUN" ? ("DRY_RUN" as const) : ("QUEUED" as const),
          isDryRun: mode === "DRY_RUN",
          isSimulated: mode === "MOCK",
        };
      }),
    });
  }

  // WhatsApp: rate-limited individual sends.
  if (modes.WHATSAPP && modes.WHATSAPP !== "DRY_RUN") {
    const dt = await loadIntegration("DOUBLETICK");
    const rate = Math.max(1, Math.min(campaign.rateLimitPerMinute, dt.config.throttlePerMinute));
    const queued = await prisma.messageDelivery.findMany({ where: { campaignId, channel: "WHATSAPP", status: "QUEUED" }, select: { id: true }, orderBy: { createdAt: "asc" } });
    const spacing = 60_000 / rate;
    // Fresh job ids per execution run (resume after pause); the DB claim still prevents double sends.
    const runNonce = Date.now().toString(36);
    for (let i = 0; i < queued.length; i++) {
      await enqueue("wa.send", { deliveryId: queued[i].id }, { delayMs: Math.floor(i * spacing), jobId: `wa:${queued[i].id}:${runNonce}` });
    }
  }
  // Email: one Zoho MA campaign per (category, template) group with an isolated list.
  if (modes.EMAIL) {
    const groups = groupsOf(campaign.providerRefs);
    for (let idx = 0; idx < groups.length; idx++) {
      if (modes.EMAIL === "DRY_RUN") {
        await saveGroup(campaignId, idx, { status: "dry_run" });
        continue;
      }
      if (!groups[idx].status || groups[idx].status === "pending") {
        await enqueue("email.dispatch", { campaignId, groupIndex: idx }, { jobId: `email:${campaignId}:${idx}` });
      }
    }
  }
  await checkCompletion(campaignId);
}

export async function checkCompletion(campaignId: string) {
  const c = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!c || c.status !== "RUNNING") return;
  const outstanding = await prisma.messageDelivery.count({ where: { campaignId, status: { in: ["PENDING", "QUEUED", "SUBMITTED"] } } });
  const unmaterialised = await prisma.campaignMessageAssignment.count({ where: { campaignId, status: "PLANNED", delivery: null } });
  if (outstanding === 0 && unmaterialised === 0) {
    const r = await prisma.campaign.updateMany({ where: { id: campaignId, status: "RUNNING" }, data: { status: "COMPLETED", completedAt: new Date() } });
    if (r.count) {
      const counts = await prisma.messageDelivery.groupBy({ by: ["status"], where: { campaignId }, _count: true });
      await audit({ action: "campaign.execution_completed", entityType: "campaign", entityId: campaignId, campaignId, metadata: { statusCounts: Object.fromEntries(counts.map((x) => [x.status, x._count])) } });
    }
  }
}

// ─── wa.send ─────────────────────────────────────────────────────────

export async function sendWhatsAppDelivery(deliveryId: string) {
  const d = await prisma.messageDelivery.findUnique({
    where: { id: deliveryId },
    include: { campaign: true, assignment: { include: { recipient: true } } },
  });
  if (!d || d.channel !== "WHATSAPP") return;
  if (d.campaign.status !== "RUNNING") return; // paused or cancelled: leave QUEUED/CANCELLED as is
  if (d.nextAttemptAt && d.nextAttemptAt.getTime() > Date.now() + 1000) return; // early duplicate trigger

  const mode = await effectiveMode("WHATSAPP", d.campaign.isLive);
  if (mode === "BLOCKED") {
    await prisma.campaign.updateMany({ where: { id: d.campaignId, status: "RUNNING" }, data: { status: "PAUSED", pausedAt: new Date(), failureReason: "Auto-paused: DoubleTick is no longer LIVE." } });
    return;
  }
  if (mode === "DRY_RUN") return;

  // Claim (idempotency guard): only one worker can move QUEUED → SUBMITTED.
  const claimed = await prisma.messageDelivery.updateMany({
    where: { id: d.id, status: "QUEUED", campaign: { status: "RUNNING" } },
    data: { status: "SUBMITTED", attemptCount: { increment: 1 }, lastAttemptAt: new Date(), submittedAt: d.submittedAt ?? new Date() },
  });
  if (claimed.count === 0) return;

  const contact = d.assignment.recipient.contactSnapshot as { phoneE164?: string };
  const rendered = d.assignment.rendered as { whatsapp?: DoubleTickTemplateContent } | null;
  const dt = await loadIntegration("DOUBLETICK");
  const attempt = d.attemptCount + 1;
  if (!contact.phoneE164 || !rendered?.whatsapp) {
    await applyDeliveryStatus(d.id, { toStatus: "FAILED", source: "SYSTEM", failureCode: "INVALID_SNAPSHOT", failureReason: "Frozen snapshot has no phone or rendered template" });
    return checkCompletion(d.campaignId);
  }
  const from = dt.config.senderNumber ?? "";
  if (mode === "LIVE" && !from) {
    await applyDeliveryStatus(d.id, { toStatus: "FAILED", source: "SYSTEM", failureCode: "NO_SENDER", failureReason: "DoubleTick sender number not configured" });
    return checkCompletion(d.campaignId);
  }

  const { provider } = await getWhatsAppProvider();
  const outcome = await provider.sendTemplate({
    from: from || "+910000000000",
    to: contact.phoneE164,
    content: rendered.whatsapp,
    customData: { nccDeliveryId: d.id, nccCampaignId: d.campaignId },
  });

  switch (outcome.kind) {
    case "accepted":
      await prisma.messageDelivery.update({ where: { id: d.id }, data: { providerMessageId: outcome.messageId } });
      await applyDeliveryStatus(d.id, {
        toStatus: "ACCEPTED",
        source: provider.kind === "mock" ? "SIMULATION" : "API_RESPONSE",
        detail: { httpStatus: outcome.httpStatus, providerStatus: outcome.providerStatus, attempt },
      });
      if (provider.kind === "mock") await enqueue("mock.simulate", { deliveryId: d.id }, { delayMs: 1500 });
      break;
    case "rejected":
      if (outcome.messageId) await prisma.messageDelivery.update({ where: { id: d.id }, data: { providerMessageId: outcome.messageId } }).catch(() => undefined);
      await applyDeliveryStatus(d.id, { toStatus: "FAILED", source: "API_RESPONSE", failureCode: "PROVIDER_REJECTED", failureReason: outcome.error, detail: { httpStatus: outcome.httpStatus, attempt } });
      break;
    case "http_error":
    case "network_error": {
      const cls = outcome.kind === "http_error" ? classifyHttpOutcome({ status: outcome.httpStatus }) : classifyHttpOutcome({ networkError: outcome.phase });
      const detail = { attempt, ...(outcome.kind === "http_error" ? { httpStatus: outcome.httpStatus } : { phase: outcome.phase }), error: outcome.error, classification: cls };
      if (cls === "retryable" && attempt < MAX_WA_ATTEMPTS) {
        const delay = backoffMs(attempt);
        await prisma.messageDelivery.update({ where: { id: d.id }, data: { status: "QUEUED", nextAttemptAt: new Date(Date.now() + delay) } });
        await prisma.deliveryEvent.create({ data: { deliveryId: d.id, source: "API_RESPONSE", fromStatus: "SUBMITTED", toStatus: "QUEUED", detail: { ...detail, retryInMs: delay } as Prisma.InputJsonValue, occurredAt: new Date() } });
        await enqueue("wa.send", { deliveryId: d.id }, { delayMs: delay, jobId: `wa:${d.id}:${attempt + 1}` });
        return;
      }
      await applyDeliveryStatus(d.id, {
        toStatus: "FAILED",
        source: "API_RESPONSE",
        failureCode: cls === "unconfirmed" ? "UNCONFIRMED_SUBMISSION" : cls === "retryable" ? "RETRIES_EXHAUSTED" : "PROVIDER_ERROR",
        failureReason:
          cls === "unconfirmed"
            ? `Provider outcome unknown (${outcome.error}). Not retried automatically to avoid a duplicate message — verify in DoubleTick before any manual resend.`
            : outcome.error,
        detail,
      });
    }
  }
  await checkCompletion(d.campaignId);
}

// ─── email.dispatch ──────────────────────────────────────────────────

export async function dispatchEmailGroup(campaignId: string, groupIndex: number) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.status !== "RUNNING") return;
  const group = groupsOf(campaign.providerRefs)[groupIndex];
  if (!group || (group.status && group.status !== "pending")) return;
  const mode = await effectiveMode("EMAIL", campaign.isLive);
  if (mode === "BLOCKED" || mode === "DRY_RUN") return;

  const deliveries = await prisma.messageDelivery.findMany({
    where: { campaignId, channel: "EMAIL", status: "QUEUED", assignment: { categoryId: group.categoryId, templateId: group.templateId } },
    include: { assignment: { include: { recipient: true, templateVersion: true } } },
  });
  if (!deliveries.length) return checkCompletion(campaignId);
  const ids = deliveries.map((d) => d.id);
  const claimed = await prisma.messageDelivery.updateMany({ where: { id: { in: ids }, status: "QUEUED" }, data: { status: "SUBMITTED", submittedAt: new Date(), attemptCount: { increment: 1 }, lastAttemptAt: new Date() } });
  if (claimed.count === 0) return;

  const emailOf = (d: (typeof deliveries)[number]) => (d.assignment.recipient.contactSnapshot as { email?: string }).email!;
  const emails = [...new Set(deliveries.map(emailOf).filter(Boolean))];
  const { provider } = await getEmailProvider();
  const ma = await loadIntegration("ZOHO_MA");
  const failAll = async (code: string, reason: string) => {
    for (const d of deliveries) await applyDeliveryStatus(d.id, { toStatus: "FAILED", source: "SYSTEM", failureCode: code, failureReason: reason });
    await saveGroup(campaignId, groupIndex, { status: "failed", error: reason });
    await audit({ action: "campaign.email_group_failed", entityType: "campaign", entityId: campaignId, campaignId, metadata: { groupIndex, code, reason } });
    await checkCompletion(campaignId);
  };

  try {
    const snap = deliveries[0].assignment.templateVersion?.snapshot as { subject?: string } | undefined;
    const subject = (deliveries[0].assignment.rendered as { subject?: string } | null)?.subject ?? snap?.subject;
    if (!subject) return failAll("NO_SUBJECT", "Frozen template has no subject");
    if (mode === "LIVE" && !ma.config.fromEmail) return failAll("NO_SENDER", "Zoho MA sender email is not configured");

    // 1. Isolated, campaign-specific list (never reused across campaigns/categories).
    const listName = `${ma.config.listPrefix}-${campaignId.slice(-8)}-${groupIndex + 1}-${Date.now().toString(36)}`.slice(0, 50);
    const { listKey } = await provider.createList(listName, emails.slice(0, 10), `NCC campaign ${campaign.name} group ${groupIndex + 1}`);
    const rest = emails.slice(10);
    const addRes = rest.length ? await provider.addEmailsToList(listKey, rest) : { added: 0, failedBatches: [] };
    await saveGroup(campaignId, groupIndex, { listKey, status: "list_synced", expected: emails.length });
    if (addRes.failedBatches.length) {
      return failAll("LIST_SYNC_FAILED", `Audience sync failed for ${addRes.failedBatches.reduce((n, b) => n + b.emails.length, 0)} address(es); campaign NOT sent. ${addRes.failedBatches[0].error}`);
    }
    // 2. Verify the provider list holds exactly the frozen audience before sending.
    const verified = await provider.getListLeadCount(listKey);
    await saveGroup(campaignId, groupIndex, { verifiedCount: verified });
    if (verified !== emails.length) {
      return failAll("AUDIENCE_VERIFICATION_FAILED", `Zoho list holds ${verified ?? "unknown"} leads but ${emails.length} were frozen. Not sent — reconcile the list in Zoho, then re-run.`);
    }
    // 3. Create campaign with dashboard-hosted, frozen content and send.
    const contentUrl = `${env().APP_URL}/api/public/email-content/${group.contentToken}`;
    const { campaignKey } = await provider.createCampaign({
      name: `${campaign.name} — ${groupIndex + 1}`.slice(0, 100),
      fromEmail: ma.config.fromEmail ?? "simulated@example.com",
      fromName: ma.config.fromName,
      subject,
      listKey,
      contentUrl,
      topicId: ma.config.topicId,
    });
    await saveGroup(campaignId, groupIndex, { campaignKey });
    const sent = await provider.sendCampaign(campaignKey);
    await saveGroup(campaignId, groupIndex, { status: "sent", simulated: provider.kind === "mock" });
    for (const d of deliveries) {
      await applyDeliveryStatus(d.id, {
        toStatus: "ACCEPTED",
        source: provider.kind === "mock" ? "SIMULATION" : "API_RESPONSE",
        detail: { listKey, campaignKey, providerStatus: sent.status, note: "Campaign accepted by Zoho Marketing Automation (not yet delivered)" },
      });
    }
    await audit({ action: "campaign.email_group_sent", entityType: "campaign", entityId: campaignId, campaignId, metadata: { groupIndex, listKey, campaignKey, recipients: emails.length, simulated: provider.kind === "mock" } });
    const delays = provider.kind === "mock" ? [3000] : [15 * 60_000, 2 * 3600_000, 24 * 3600_000, 72 * 3600_000];
    for (const delay of delays) await enqueue("email.reconcile", { campaignId, groupIndex }, { delayMs: delay, jobId: `email-rec:${campaignId}:${groupIndex}:${delay}` });
  } catch (err) {
    const msg = (err as Error).message;
    // Anything after createCampaign may have reached Zoho; we never auto-retry the send.
    await failAll("PROVIDER_ERROR", `Zoho Marketing Automation error: ${msg}. Not retried automatically — check the campaign in Zoho before re-running.`);
  }
  await checkCompletion(campaignId);
}

// ─── email.reconcile ─────────────────────────────────────────────────

export async function reconcileEmailGroup(campaignId: string, groupIndex: number) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) return;
  const group = groupsOf(campaign.providerRefs)[groupIndex];
  if (!group?.campaignKey || group.status !== "sent") return;
  const { provider } = await getEmailProvider();
  const deliveries = await prisma.messageDelivery.findMany({
    where: { campaignId, channel: "EMAIL", assignment: { categoryId: group.categoryId, templateId: group.templateId } },
    include: { assignment: { include: { recipient: true } } },
  });
  const byEmail = new Map(deliveries.map((d) => [(d.assignment.recipient.contactSnapshot as { email?: string }).email ?? "", d]));

  if (provider.kind === "mock") {
    // Simulated engagement, clearly labelled — never shown as real provider data.
    let i = 0;
    for (const d of deliveries) {
      i++;
      const t = new Date();
      if (i % 29 === 0) {
        await applyDeliveryStatus(d.id, { toStatus: "BOUNCED", source: "SIMULATION", failureCode: "SIMULATED_BOUNCE", failureReason: "(simulated) hard bounce" });
        continue;
      }
      await applyDeliveryStatus(d.id, { toStatus: "SENT", source: "SIMULATION", occurredAt: t });
      if (i % 3 !== 0) await recordEngagement(d.id, "opened", t, "SIMULATION");
      if (i % 7 === 0) await recordEngagement(d.id, "clicked", t, "SIMULATION");
    }
    await saveGroup(campaignId, groupIndex, { report: { simulated: true }, reportAt: new Date().toISOString() });
    return;
  }

  const report = await provider.getCampaignReport(group.campaignKey);
  await saveGroup(campaignId, groupIndex, { report: report as unknown as Record<string, unknown>, reportAt: new Date().toISOString() });
  const pull = async (action: Parameters<typeof provider.getCampaignRecipients>[1], fn: (email: string, time: Date) => Promise<void>) => {
    for (let from = 1; from < 200_000; from += 500) {
      const rows = await provider.getCampaignRecipients(group.campaignKey!, action, from, 500);
      for (const r of rows) await fn(r.email, r.time ? new Date(r.time) : new Date());
      if (rows.length < 500) break;
    }
  };
  await pull("sentleads", async (email, at) => {
    const d = byEmail.get(email);
    if (d) await applyDeliveryStatus(d.id, { toStatus: "SENT", source: "REPORT_RECONCILIATION", occurredAt: at });
  });
  for (const action of ["senthardbounce", "sentsoftbounce"] as const) {
    await pull(action, async (email, at) => {
      const d = byEmail.get(email);
      if (!d) return;
      await applyDeliveryStatus(d.id, { toStatus: "BOUNCED", source: "REPORT_RECONCILIATION", occurredAt: at, failureCode: action.toUpperCase(), failureReason: action === "senthardbounce" ? "Hard bounce" : "Soft bounce" });
      if (action === "senthardbounce") await addSuppression({ channel: "EMAIL", identifierType: "EMAIL", identifierValue: email, reason: "HARD_BOUNCE", source: "zoho_ma_report" }, null).catch(() => undefined);
    });
  }
  await pull("openedleads", async (email, at) => {
    const d = byEmail.get(email);
    if (d) await recordEngagement(d.id, "opened", at, "REPORT_RECONCILIATION");
  });
  await pull("clickedleads", async (email, at) => {
    const d = byEmail.get(email);
    if (d) await recordEngagement(d.id, "clicked", at, "REPORT_RECONCILIATION");
  });
  await pull("optoutleads", async (email) => {
    const d = byEmail.get(email);
    if (!d) return;
    await recordConsent({ clientId: d.clientId, channel: "EMAIL", status: "REVOKED", source: "PROVIDER_UNSUBSCRIBE", evidence: `Unsubscribed via Zoho MA campaign ${group.campaignKey}` }, null).catch(() => undefined);
    await addSuppression({ channel: "EMAIL", identifierType: "EMAIL", identifierValue: email, reason: "UNSUBSCRIBED", source: "zoho_ma_report" }, null).catch(() => undefined);
  });
  await audit({ action: "campaign.email_reconciled", entityType: "campaign", entityId: campaignId, campaignId, metadata: { groupIndex, report: { sent: report.sent, delivered: report.delivered, opens: report.opens, clicks: report.uniqueClicks, bounces: report.bounces } } });
}

// ─── mock.simulate (WhatsApp) ────────────────────────────────────────

export async function simulateWhatsAppLifecycle(deliveryId: string) {
  const d = await prisma.messageDelivery.findUnique({ where: { id: deliveryId } });
  if (!d || !d.isSimulated || !d.providerMessageId) return;
  const { processStatusEvent } = await import("./webhooks");
  const h = [...d.id].reduce((a, c) => a + c.charCodeAt(0), 0);
  const base = Date.now();
  await processStatusEvent({ messageId: d.providerMessageId, status: "SENT", statusTimestamp: new Date(base).toISOString() }, { simulated: true });
  if (h % 17 === 0) {
    await processStatusEvent({ messageId: d.providerMessageId, status: "FAILED", statusTimestamp: new Date(base + 2000).toISOString(), failMessage: "(simulated) Message undeliverable" }, { simulated: true });
    return;
  }
  await processStatusEvent({ messageId: d.providerMessageId, status: "DELIVERED", statusTimestamp: new Date(base + 4000).toISOString() }, { simulated: true });
  if (h % 3 !== 0) await processStatusEvent({ messageId: d.providerMessageId, status: "READ", statusTimestamp: new Date(base + 60_000).toISOString() }, { simulated: true });
}

// ─── scheduler.tick ──────────────────────────────────────────────────

export async function schedulerTick() {
  const now = new Date();
  const due = await prisma.campaign.findMany({ where: { status: "SCHEDULED", scheduledAt: { lte: now }, deletedAt: null }, select: { id: true } });
  for (const c of due) {
    const r = await prisma.campaign.updateMany({ where: { id: c.id, status: "SCHEDULED" }, data: { status: "QUEUED", queuedAt: now } });
    if (r.count) {
      await audit({ action: "campaign.schedule_triggered", entityType: "campaign", entityId: c.id, campaignId: c.id });
      await enqueue("campaign.execute", { campaignId: c.id }, { jobId: `execute:${c.id}:sched` });
    }
  }
  // Recover deliveries whose in-memory/delayed job was lost (e.g. restart in inline mode).
  const stuck = await prisma.messageDelivery.findMany({
    where: { channel: "WHATSAPP", status: "QUEUED", campaign: { status: "RUNNING" }, OR: [{ nextAttemptAt: { lte: new Date(now.getTime() - 5 * 60_000) } }, { nextAttemptAt: null, createdAt: { lte: new Date(now.getTime() - 30 * 60_000) } }] },
    select: { id: true, attemptCount: true },
    take: 500,
  });
  for (const s of stuck) await enqueue("wa.send", { deliveryId: s.id }, { jobId: `wa:${s.id}:recover:${Math.floor(now.getTime() / 600_000)}` });

  // Scheduled CRM sync.
  const crm = await loadIntegration("ZOHO_CRM");
  if (crm.mode !== "MOCK" && crm.secrets.refreshToken) {
    const last = crm.row.lastSyncAt?.getTime() ?? 0;
    if (Date.now() - last > crm.config.syncIntervalMinutes * 60_000) {
      await enqueue("crm.sync", { scheduled: true }, { jobId: `crm-sync:${Math.floor(Date.now() / (crm.config.syncIntervalMinutes * 60_000))}` });
    }
  }
  // Retention housekeeping (cheap, idempotent).
  const settings = await getAppSettings();
  await prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });
  await prisma.webhookEvent.deleteMany({ where: { receivedAt: { lt: new Date(now.getTime() - settings.retention.webhookEventsDays * 86400_000) }, status: { in: ["PROCESSED", "DUPLICATE", "IGNORED"] } } });
}

