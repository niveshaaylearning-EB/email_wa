import "server-only";
import { Prisma, type Campaign } from "@prisma/client";
import { prisma, type Tx } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { badRequest, conflict, forbidden, notFound } from "@/lib/errors";
import type { CampaignDraft } from "@/lib/contracts";
import { assertTransition } from "@/lib/domain/campaign-state";
import {
  channelsFor,
  computeEligibility,
  type AudienceMember,
  type ChannelKey,
  type ConsentState,
  type EligibilityResult,
  type ReviewDecision,
  type SelectedCategory,
} from "@/lib/domain/eligibility";
import { renderTemplate, validateTemplateDefinition } from "@/lib/domain/template-render";
import { stableHash, randomToken } from "@/lib/crypto";
import { istLocalToUtc } from "@/lib/time";
import { env } from "@/lib/env";
import { getAppSettings, inQuietHours } from "./settings";
import { currentConsents } from "./clients";
import { toRenderable } from "./templates";
import { loadIntegration, PROVIDER_LABELS } from "./integrations";
import { enqueue } from "@/lib/queue";
import type { SessionUser } from "@/lib/auth/session";

type Actor = AuditActor & { role?: string };

// ─── Drafts ──────────────────────────────────────────────────────────────

async function assertTemplatesAuthorized(categories: CampaignDraft["categories"], channelMode: CampaignDraft["channelMode"]) {
  if (!categories.length) return;
  const mappings = await prisma.categoryTemplate.findMany({
    where: { categoryId: { in: categories.map((c) => c.categoryId) }, removedAt: null },
    include: { template: { select: { id: true, channel: true, archivedAt: true, name: true } } },
  });
  const allowed = new Set(mappings.filter((m) => !m.template.archivedAt).map((m) => `${m.categoryId}:${m.templateId}:${m.template.channel}`));
  const channels = channelsFor(channelMode);
  for (const c of categories) {
    for (const [channel, tid] of [
      ["EMAIL", c.emailTemplateId],
      ["WHATSAPP", c.whatsappTemplateId],
    ] as const) {
      if (!tid) continue;
      if (!channels.includes(channel)) continue;
      if (!allowed.has(`${c.categoryId}:${tid}:${channel}`)) {
        throw forbidden(`Template ${tid} is not authorised for this category on ${channel === "EMAIL" ? "email" : "WhatsApp"}. Map it in the Template Library first.`);
      }
    }
  }
}

function draftData(input: CampaignDraft, actorId: string) {
  const scheduledAt = input.scheduleType === "SCHEDULED" && input.scheduledAtLocal ? istLocalToUtc(input.scheduledAtLocal) : null;
  return {
    name: input.name,
    description: input.description || null,
    purpose: input.purpose,
    channelMode: input.channelMode,
    overlapStrategy: input.overlapStrategy,
    scheduledAt,
    timezone: "Asia/Kolkata",
    rateLimitPerMinute: input.rateLimitPerMinute,
    updatedById: actorId,
  };
}

function categoryRows(input: CampaignDraft) {
  const channels = channelsFor(input.channelMode);
  return input.categories.map((c) => ({
    categoryId: c.categoryId,
    priority: c.priority,
    emailTemplateId: channels.includes("EMAIL") ? c.emailTemplateId ?? null : null,
    whatsappTemplateId: channels.includes("WHATSAPP") ? c.whatsappTemplateId ?? null : null,
  }));
}

export async function createCampaignDraft(input: CampaignDraft, actor: Actor) {
  await assertTemplatesAuthorized(input.categories, input.channelMode);
  const c = await prisma.campaign.create({
    data: { ...draftData(input, actor.id), createdById: actor.id, categories: { create: categoryRows(input) } },
  });
  await audit({ actor, action: "campaign.created", entityType: "campaign", entityId: c.id, campaignId: c.id, metadata: { name: c.name, channelMode: c.channelMode, categories: input.categories } });
  return c;
}

export async function updateCampaignDraft(id: string, input: CampaignDraft, actor: Actor) {
  const existing = await prisma.campaign.findUnique({ where: { id } });
  if (!existing || existing.deletedAt) throw notFound("Campaign");
  assertTransition("edit", existing.status);
  if (input.expectedVersion !== undefined && input.expectedVersion !== existing.version) {
    throw conflict("This campaign was modified by someone else. Reload to see the latest version.");
  }
  await assertTemplatesAuthorized(input.categories, input.channelMode);
  const c = await prisma.$transaction(async (tx) => {
    await tx.campaignCategory.deleteMany({ where: { campaignId: id } });
    return tx.campaign.update({
      where: { id, version: existing.version },
      data: {
        ...draftData(input, actor.id),
        version: { increment: 1 },
        // Edits after rejection send it back to draft; selection changes invalidate review decisions.
        status: existing.status === "REJECTED" ? "DRAFT" : existing.status,
        reviewDecisions: {},
        categories: { create: categoryRows(input) },
      },
    });
  });
  await audit({ actor, action: "campaign.updated", entityType: "campaign", entityId: id, campaignId: id, metadata: { version: c.version, categories: input.categories, channelMode: input.channelMode, overlapStrategy: input.overlapStrategy } });
  return c;
}

// ─── Audience computation ────────────────────────────────────────────────

export interface SelectionInput {
  campaignId: string;
  campaignName: string;
  channelMode: "EMAIL" | "WHATSAPP" | "BOTH";
  overlapStrategy: "PRIORITY" | "PER_CATEGORY" | "EXCLUDE_CONFLICTS" | "MANUAL_REVIEW";
  categories: { categoryId: string; priority: number; emailTemplateId: string | null; whatsappTemplateId: string | null }[];
  reviewDecisions?: Record<string, Partial<Record<ChannelKey, ReviewDecision>>>;
}

/** Loads current DB state and runs the eligibility engine. Used by preview, approval and dry runs. */
export async function computeAudience(sel: SelectionInput, db: Tx | typeof prisma = prisma) {
  const settings = await getAppSettings();
  const crm = await loadIntegration("ZOHO_CRM");
  const categoryIds = sel.categories.map((c) => c.categoryId);
  const memberships = await db.clientCategory.findMany({
    where: { categoryId: { in: categoryIds }, removedAt: null, category: { archivedAt: null } },
    select: { categoryId: true, client: true },
  });
  const byClient = new Map<string, AudienceMember>();
  const clientRecords = new Map<string, (typeof memberships)[number]["client"]>();
  for (const m of memberships) {
    clientRecords.set(m.client.id, m.client);
    const entry = byClient.get(m.client.id) ?? {
      client: {
        id: m.client.id,
        fullName: m.client.fullName,
        emailRaw: m.client.email,
        emailNormalized: m.client.emailNormalized,
        phoneRaw: m.client.phoneRaw,
        phoneE164: m.client.phoneE164,
        phoneValid: m.client.phoneValid,
        crmEmailOptOut: m.client.crmEmailOptOut,
        crmStatus: m.client.crmStatus,
        deletedInCrmAt: m.client.deletedInCrmAt,
        duplicateOfId: m.client.duplicateOfId,
      },
      categoryIds: [],
    };
    entry.categoryIds.push(m.categoryId);
    byClient.set(m.client.id, entry);
  }
  const clientIds = [...byClient.keys()];
  const consentRows = await currentConsents(clientIds);
  const consents = new Map<string, ConsentState>();
  for (const [cid, v] of consentRows) consents.set(cid, { EMAIL: v.EMAIL?.status, WHATSAPP: v.WHATSAPP?.status });

  const identifiers = [...byClient.values()].flatMap((m) => [m.client.emailNormalized, m.client.phoneE164].filter((x): x is string => !!x));
  const supRows = identifiers.length
    ? await db.suppressionEntry.findMany({ where: { identifierValue: { in: identifiers }, liftedAt: null }, select: { channel: true, identifierValue: true } })
    : [];
  const suppressions = new Set(supRows.map((s) => `${s.channel ?? "ALL"}:${s.identifierValue}`));

  const templateIds = [...new Set(sel.categories.flatMap((c) => [c.emailTemplateId, c.whatsappTemplateId]).filter((x): x is string => !!x))];
  const templates = await db.template.findMany({ where: { id: { in: templateIds } } });
  const renderables = new Map(templates.map((t) => [t.id, toRenderable(t)]));

  const categories: SelectedCategory[] = sel.categories.map((c) => ({
    categoryId: c.categoryId,
    priority: c.priority,
    templates: { EMAIL: c.emailTemplateId, WHATSAPP: c.whatsappTemplateId },
  }));
  const reviewDecisions = new Map(Object.entries(sel.reviewDecisions ?? {}));

  const result = computeEligibility({
    campaignId: sel.campaignId,
    channels: channelsFor(sel.channelMode),
    strategy: sel.overlapStrategy,
    categories,
    members: [...byClient.values()],
    consents,
    suppressions,
    consentPolicy: settings.consentPolicy,
    inactiveCrmStatuses: crm.config.inactiveStatuses,
    reviewDecisions,
    missingTemplateData: (clientId, templateId) => {
      const t = renderables.get(templateId);
      const c = clientRecords.get(clientId);
      if (!t || !c || t.channel !== "WHATSAPP") return [];
      return renderTemplate(t, { client: c, campaign: { name: sel.campaignName } }).missing;
    },
  });
  return { result, clientRecords, renderables, templates };
}

async function selectionFor(campaignId: string): Promise<{ campaign: Campaign; sel: SelectionInput }> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, include: { categories: true } });
  if (!campaign || campaign.deletedAt) throw notFound("Campaign");
  return {
    campaign,
    sel: {
      campaignId: campaign.id,
      campaignName: campaign.name,
      channelMode: campaign.channelMode,
      overlapStrategy: campaign.overlapStrategy,
      categories: campaign.categories,
      reviewDecisions: campaign.reviewDecisions as SelectionInput["reviewDecisions"],
    },
  };
}

export interface ValidationReport {
  errors: string[];
  warnings: string[];
}

export async function validateCampaign(campaignId: string, audience?: EligibilityResult): Promise<ValidationReport> {
  const campaign = await prisma.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { categories: { include: { category: true } } },
  });
  const errors: string[] = [];
  const warnings: string[] = [];
  const channels = channelsFor(campaign.channelMode);
  if (!campaign.categories.length) errors.push("Select at least one category.");
  const templateIds = campaign.categories.flatMap((c) => [c.emailTemplateId, c.whatsappTemplateId]).filter((x): x is string => !!x);
  const templates = new Map((await prisma.template.findMany({ where: { id: { in: templateIds } } })).map((t) => [t.id, t]));
  const mappings = await prisma.categoryTemplate.findMany({ where: { categoryId: { in: campaign.categories.map((c) => c.categoryId) }, removedAt: null } });
  const mapped = new Set(mappings.map((m) => `${m.categoryId}:${m.templateId}`));

  for (const cc of campaign.categories) {
    if (cc.category.archivedAt) errors.push(`Category "${cc.category.name}" is archived.`);
    for (const ch of channels) {
      const tid = ch === "EMAIL" ? cc.emailTemplateId : cc.whatsappTemplateId;
      const label = ch === "EMAIL" ? "email" : "WhatsApp";
      if (!tid) {
        errors.push(`Choose a ${label} template for "${cc.category.name}".`);
        continue;
      }
      const t = templates.get(tid);
      if (!t || t.archivedAt) errors.push(`The ${label} template for "${cc.category.name}" no longer exists.`);
      else {
        if (!mapped.has(`${cc.categoryId}:${tid}`)) errors.push(`"${t.name}" is no longer authorised for "${cc.category.name}".`);
        if (t.approvalStatus !== "APPROVED") errors.push(`"${t.name}" is not marked approved (${t.approvalStatus.toLowerCase()}).`);
        for (const issue of validateTemplateDefinition(toRenderable(t))) {
          (issue.level === "error" ? errors : warnings).push(`${t.name}: ${issue.message}`);
        }
      }
    }
  }
  if (campaign.scheduledAt && campaign.scheduledAt.getTime() < Date.now() + 2 * 60_000 && ["DRAFT", "REJECTED", "PENDING_APPROVAL"].includes(campaign.status)) {
    errors.push("Scheduled time must be at least 2 minutes in the future.");
  }
  const settings = await getAppSettings();
  if (campaign.scheduledAt && inQuietHours(settings, campaign.scheduledAt)) {
    warnings.push(`Scheduled time falls inside quiet hours (${settings.safety.quietHoursStart}–${settings.safety.quietHoursEnd} IST).`);
  }
  for (const ch of channels) {
    const provider = ch === "EMAIL" ? "ZOHO_MA" : "DOUBLETICK";
    const integ = await loadIntegration(provider);
    if (integ.mode === "MOCK") warnings.push(`${PROVIDER_LABELS[provider]} is in MOCK mode — execution will be simulated and labelled as such.`);
    if (integ.mode === "DRY_RUN") warnings.push(`${PROVIDER_LABELS[provider]} is in DRY-RUN mode — messages will be rendered and recorded but not sent.`);
    if (ch === "EMAIL" && settings.safety.requireDisclaimerInEmail && !settings.compliance.emailDisclaimer.trim()) {
      (integ.mode === "LIVE" ? errors : warnings).push("No email disclaimer is configured (Settings → Compliance). Required before live email campaigns.");
    }
    if (integ.mode === "LIVE" && ch === "EMAIL" && !(integ.config as { fromEmail?: string }).fromEmail) {
      errors.push("Zoho Marketing Automation sender email (from address) is not configured.");
    }
    if (integ.mode === "LIVE" && ch === "WHATSAPP" && !(integ.config as { senderNumber?: string }).senderNumber) {
      errors.push("DoubleTick sender number is not configured.");
    }
  }
  if (audience) {
    if (audience.summary.messageVolume === 0 && audience.summary.needsReview === 0) errors.push("No eligible recipients — nothing would be sent.");
    if (audience.summary.needsReview > 0) {
      errors.push(`${audience.summary.needsReview} recipient(s) belong to overlapping categories with different templates and need a review decision.`);
    }
    if (audience.summary.messageVolume > settings.safety.largeCampaignThreshold) {
      warnings.push(`Large campaign: ${audience.summary.messageVolume.toLocaleString("en-IN")} messages. Approver must re-type the count to confirm.`);
    }
    if (campaign.overlapStrategy === "PER_CATEGORY" && audience.summary.conflicts > 0) {
      warnings.push(`${audience.summary.conflicts} overlapping recipient-channel(s) will receive more than one message (one per category template).`);
    }
  }
  return { errors, warnings };
}

export async function previewCampaignAudience(campaignId: string, opts: { sampleSize?: number } = {}) {
  const { sel } = await selectionFor(campaignId);
  const { result, clientRecords } = await computeAudience(sel);
  const validation = await validateCampaign(campaignId, result);
  const reviewItems = result.recipients
    .flatMap((r) =>
      r.assignments
        .filter((a) => a.status === "NEEDS_REVIEW" || (a.conflictCategoryIds && a.conflictCategoryIds.length > 1))
        .map((a) => ({
          clientId: r.clientId,
          clientName: clientRecords.get(r.clientId)?.fullName ?? "",
          channel: a.channel,
          status: a.status,
          conflictCategoryIds: a.conflictCategoryIds ?? [],
          chosenCategoryId: a.status === "NEEDS_REVIEW" ? null : a.categoryId,
          excluded: a.reasons.includes("CONFLICT_EXCLUDED"),
        })),
    )
    .slice(0, 2000);
  const sample = result.recipients.slice(0, opts.sampleSize ?? 200).map((r) => {
    const c = clientRecords.get(r.clientId)!;
    return {
      clientId: r.clientId,
      fullName: c.fullName,
      email: c.email,
      phoneE164: c.phoneE164,
      status: r.status,
      exclusionReasons: r.exclusionReasons,
      matchedCategoryIds: r.matchedCategoryIds,
      assignments: r.assignments.map((a) => ({ channel: a.channel, categoryId: a.categoryId, templateId: a.templateId, status: a.status, reasons: a.reasons })),
    };
  });
  return { summary: result.summary, validation, reviewItems, sample, totalRecipients: result.recipients.length };
}

export async function setReviewDecisions(
  campaignId: string,
  decisions: { clientId: string; channel: ChannelKey; decision: ReviewDecision }[],
  actor: Actor,
) {
  const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (!["DRAFT", "REJECTED", "PENDING_APPROVAL"].includes(c.status)) throw conflict("Review decisions can only change before approval.");
  const current = (c.reviewDecisions ?? {}) as Record<string, Partial<Record<ChannelKey, ReviewDecision>>>;
  for (const d of decisions) current[d.clientId] = { ...(current[d.clientId] ?? {}), [d.channel]: d.decision };
  await prisma.campaign.update({ where: { id: campaignId }, data: { reviewDecisions: current as Prisma.InputJsonValue, updatedById: actor.id, version: { increment: 1 } } });
  await audit({ actor, action: "campaign.review_decisions", entityType: "campaign", entityId: campaignId, campaignId, metadata: { count: decisions.length } });
}

// ─── Workflow ────────────────────────────────────────────────────────────

export async function submitForApproval(campaignId: string, actor: Actor) {
  const { campaign, sel } = await selectionFor(campaignId);
  const next = assertTransition("submit", campaign.status);
  const { result } = await computeAudience(sel);
  const v = await validateCampaign(campaignId, result);
  if (v.errors.length) throw badRequest("Campaign has validation errors.", v);
  await prisma.campaign.update({ where: { id: campaignId }, data: { status: next, submittedAt: new Date(), submittedById: actor.id, rejectedAt: null, rejectionReason: null } });
  await audit({ actor, action: "campaign.submitted", entityType: "campaign", entityId: campaignId, campaignId, metadata: { summary: result.summary, warnings: v.warnings } });
}

export async function withdrawSubmission(campaignId: string, actor: Actor) {
  const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (c.createdById !== actor.id && actor.role !== "ADMIN") throw forbidden("Only the creator can withdraw a submission.");
  await prisma.campaign.update({ where: { id: campaignId }, data: { status: assertTransition("withdraw", c.status) } });
  await audit({ actor, action: "campaign.withdrawn", entityType: "campaign", entityId: campaignId, campaignId });
}

export async function rejectCampaign(campaignId: string, reason: string, actor: Actor) {
  const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (c.createdById === actor.id || c.submittedById === actor.id) throw forbidden("Maker-checker: you cannot review a campaign you created or submitted.");
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: assertTransition("reject", c.status), rejectedAt: new Date(), rejectedById: actor.id, rejectionReason: reason },
  });
  await audit({ actor, action: "campaign.rejected", entityType: "campaign", entityId: campaignId, campaignId, metadata: { reason } });
}

export interface ApprovalInput {
  note?: string;
  confirmMessageCount: number;
  confirmLive: boolean;
}

/**
 * Maker-checker approval. In ONE serializable transaction:
 *   1. re-computes the audience from current state (no stale previews),
 *   2. requires the approver's typed message count to match exactly,
 *   3. freezes recipients, per-recipient assignments, template versions, rendered content and
 *      consent decisions, and writes an immutable snapshot (DB triggers block later edits),
 *   4. moves the campaign to APPROVED/SCHEDULED/QUEUED.
 */
export async function approveCampaign(campaignId: string, input: ApprovalInput, approver: SessionUser) {
  const { campaign, sel } = await selectionFor(campaignId);
  assertTransition("approve", campaign.status);
  if (campaign.createdById === approver.id || campaign.submittedById === approver.id) {
    throw forbidden("Maker-checker: you cannot approve a campaign you created or submitted.");
  }
  const channels = channelsFor(campaign.channelMode);
  const modes = await Promise.all(channels.map(async (ch) => ({ ch, mode: (await loadIntegration(ch === "EMAIL" ? "ZOHO_MA" : "DOUBLETICK")).mode })));
  const isLive = modes.some((m) => m.mode === "LIVE");
  if (isLive) {
    if (!env().ALLOW_LIVE_SEND) throw forbidden("Live sending is disabled on this deployment.");
    if (!input.confirmLive) throw badRequest("This campaign will send REAL messages. Tick the live-send confirmation to approve.");
  }

  const snapshot = await prisma.$transaction(
    async (tx) => {
      const { result, clientRecords, renderables, templates } = await computeAudience(sel, tx);
      const v = await validateCampaign(campaignId, result);
      if (v.errors.length) throw badRequest("Campaign has validation errors.", v);
      if (result.summary.messageVolume !== input.confirmMessageCount) {
        throw conflict(
          `The eligible audience changed since you reviewed it: ${result.summary.messageVolume.toLocaleString("en-IN")} messages now (you confirmed ${input.confirmMessageCount.toLocaleString("en-IN")}). Review again.`,
          { current: result.summary.messageVolume },
        );
      }
      if (isLive && result.summary.messageVolume > env().LIVE_SEND_MAX_RECIPIENTS) {
        throw forbidden(`Live campaigns are capped at ${env().LIVE_SEND_MAX_RECIPIENTS} messages on this deployment.`);
      }

      const versions = await tx.templateVersion.findMany({
        where: { OR: templates.map((t) => ({ templateId: t.id, version: t.currentVersion })) },
      });
      const versionByTemplate = new Map(versions.map((v) => [v.templateId, v]));

      // Recipients
      const recipientRows = result.recipients.map((r) => {
        const c = clientRecords.get(r.clientId)!;
        return {
          id: `${campaignId}_${r.clientId}`,
          campaignId,
          clientId: r.clientId,
          status: r.status,
          exclusionReasons: r.exclusionReasons,
          matchedCategoryIds: r.matchedCategoryIds,
          contactSnapshot: { fullName: c.fullName, email: c.emailNormalized, phoneE164: c.phoneE164, zohoCrmId: c.zohoCrmId } as Prisma.InputJsonValue,
          consentDecision: r.channelDecisions as unknown as Prisma.InputJsonValue,
        };
      });
      for (let i = 0; i < recipientRows.length; i += 5000) await tx.campaignRecipient.createMany({ data: recipientRows.slice(i, i + 5000) });
      const recipientIdByClient = new Map(recipientRows.map((r) => [r.clientId, r.id]));

      // Assignments with rendered content
      const assignmentRows: Prisma.CampaignMessageAssignmentCreateManyInput[] = [];
      for (const r of result.recipients) {
        const c = clientRecords.get(r.clientId)!;
        for (const a of r.assignments) {
          const t = renderables.get(a.templateId);
          let rendered: Prisma.InputJsonValue | undefined;
          if (t && a.status === "PLANNED") {
            const out = renderTemplate(t, { client: c, campaign: { name: campaign.name } });
            rendered = (a.channel === "WHATSAPP" ? { whatsapp: out.whatsapp, preview: out.body } : { subject: out.subject }) as Prisma.InputJsonValue;
          }
          assignmentRows.push({
            campaignId,
            recipientId: recipientIdByClient.get(r.clientId)!,
            channel: a.channel,
            categoryId: a.categoryId,
            templateId: a.templateId,
            templateVersionId: versionByTemplate.get(a.templateId)?.id ?? null,
            status: a.status,
            rendered,
            idempotencyKey: a.idempotencyKey,
          });
        }
      }
      for (let i = 0; i < assignmentRows.length; i += 5000) await tx.campaignMessageAssignment.createMany({ data: assignmentRows.slice(i, i + 5000) });

      // Per-category snapshot incl. membership counts and template versions
      const catInfo = await tx.category.findMany({ where: { id: { in: sel.categories.map((c) => c.categoryId) } }, select: { id: true, name: true } });
      const categoriesSnap = sel.categories.map((c) => ({
        categoryId: c.categoryId,
        name: catInfo.find((x) => x.id === c.categoryId)?.name,
        priority: c.priority,
        memberCount: result.summary.perCategory[c.categoryId]?.members ?? 0,
        plannedMessages: result.summary.perCategory[c.categoryId]?.planned ?? 0,
        emailTemplate: c.emailTemplateId ? { id: c.emailTemplateId, version: versionByTemplate.get(c.emailTemplateId)?.version, hash: versionByTemplate.get(c.emailTemplateId)?.contentHash } : null,
        whatsappTemplate: c.whatsappTemplateId ? { id: c.whatsappTemplateId, version: versionByTemplate.get(c.whatsappTemplateId)?.version, hash: versionByTemplate.get(c.whatsappTemplateId)?.contentHash } : null,
      }));
      for (const c of sel.categories) {
        await tx.campaignCategory.update({
          where: { campaignId_categoryId: { campaignId, categoryId: c.categoryId } },
          data: { memberCountAtSnapshot: result.summary.perCategory[c.categoryId]?.members ?? 0 },
        });
      }
      const summary = { ...result.summary, isLive, modes, overlapStrategy: campaign.overlapStrategy, channelMode: campaign.channelMode };
      const contentHash = stableHash({ summary, categoriesSnap, assignments: assignmentRows.map((a) => a.idempotencyKey).sort() });
      const snap = await tx.campaignSnapshot.create({
        data: {
          campaignId,
          frozenById: approver.id,
          summary: summary as unknown as Prisma.InputJsonValue,
          categories: categoriesSnap as unknown as Prisma.InputJsonValue,
          contentHash,
        },
      });

      // Email content tokens for Zoho-hosted content URLs (one per category/template group).
      const emailGroups = channels.includes("EMAIL")
        ? sel.categories
            .filter((c) => c.emailTemplateId)
            .map((c) => ({ categoryId: c.categoryId, templateId: c.emailTemplateId!, contentToken: randomToken(24) }))
        : [];

      const scheduled = campaign.scheduledAt && campaign.scheduledAt.getTime() > Date.now();
      const updated = await tx.campaign.update({
        where: { id: campaignId, version: campaign.version },
        data: {
          status: scheduled ? "SCHEDULED" : "QUEUED",
          approvedAt: new Date(),
          approvedById: approver.id,
          approvalNote: input.note ?? null,
          isLive,
          liveConfirmedAt: isLive ? new Date() : null,
          queuedAt: scheduled ? null : new Date(),
          providerRefs: { emailGroups } as unknown as Prisma.InputJsonValue,
        },
      });
      await audit(
        {
          actor: approver,
          action: "campaign.approved",
          entityType: "campaign",
          entityId: campaignId,
          campaignId,
          metadata: { snapshotId: snap.id, contentHash, summary: result.summary, categories: categoriesSnap, isLive, note: input.note, scheduledAt: campaign.scheduledAt },
        },
        tx,
      );
      return { snap, updated, scheduled };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 120_000, maxWait: 10_000 },
  );

  if (!snapshot.scheduled) await enqueue("campaign.execute", { campaignId }, { jobId: `execute:${campaignId}` });
  return snapshot.updated;
}

export async function pauseCampaign(campaignId: string, actor: Actor) {
  const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  await prisma.campaign.update({ where: { id: campaignId }, data: { status: assertTransition("pause", c.status), pausedAt: new Date() } });
  await audit({ actor, action: "campaign.paused", entityType: "campaign", entityId: campaignId, campaignId, metadata: { from: c.status } });
}

export async function resumeCampaign(campaignId: string, actor: Actor) {
  const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const wasScheduledFuture = !c.startedAt && c.scheduledAt && c.scheduledAt.getTime() > Date.now();
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: wasScheduledFuture ? "SCHEDULED" : assertTransition("resume", c.status), pausedAt: null },
  });
  await audit({ actor, action: "campaign.resumed", entityType: "campaign", entityId: campaignId, campaignId });
  if (!wasScheduledFuture) await enqueue("campaign.execute", { campaignId }, { jobId: `execute:${campaignId}:${Date.now()}` });
}

export async function cancelCampaign(campaignId: string, reason: string, actor: Actor) {
  const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const next = assertTransition("cancel", c.status);
  const cancelled = await prisma.$transaction(async (tx) => {
    await tx.campaign.update({ where: { id: campaignId }, data: { status: next, cancelledAt: new Date(), cancelledById: actor.id, failureReason: reason } });
    const pending = await tx.messageDelivery.findMany({ where: { campaignId, status: { in: ["PENDING", "QUEUED"] } }, select: { id: true, status: true } });
    if (pending.length) {
      await tx.messageDelivery.updateMany({ where: { id: { in: pending.map((p) => p.id) }, status: { in: ["PENDING", "QUEUED"] } }, data: { status: "CANCELLED" } });
      await tx.deliveryEvent.createMany({
        data: pending.map((p) => ({ deliveryId: p.id, source: "SYSTEM" as const, fromStatus: p.status, toStatus: "CANCELLED" as const, detail: { reason }, occurredAt: new Date() })),
      });
    }
    return pending.length;
  });
  await audit({ actor, action: "campaign.cancelled", entityType: "campaign", entityId: campaignId, campaignId, metadata: { reason, from: c.status, cancelledDeliveries: cancelled } });
}

export async function softDeleteDraft(campaignId: string, actor: Actor) {
  const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  if (!["DRAFT", "REJECTED"].includes(c.status)) throw conflict("Only drafts can be deleted. Cancel the campaign instead.");
  await prisma.campaign.update({ where: { id: campaignId }, data: { deletedAt: new Date() } });
  await audit({ actor, action: "campaign.deleted", entityType: "campaign", entityId: campaignId, campaignId });
}

export async function duplicateCampaign(campaignId: string, actor: Actor) {
  const c = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId }, include: { categories: true } });
  const copy = await prisma.campaign.create({
    data: {
      name: `${c.name} (copy)`.slice(0, 120),
      description: c.description,
      purpose: c.purpose,
      channelMode: c.channelMode,
      overlapStrategy: c.overlapStrategy,
      rateLimitPerMinute: c.rateLimitPerMinute,
      createdById: actor.id,
      categories: { create: c.categories.map(({ categoryId, priority, emailTemplateId, whatsappTemplateId }) => ({ categoryId, priority, emailTemplateId, whatsappTemplateId })) },
    },
  });
  await audit({ actor, action: "campaign.duplicated", entityType: "campaign", entityId: copy.id, campaignId: copy.id, metadata: { from: campaignId } });
  return copy;
}


// ─── Test sends ──────────────────────────────────────────────────────────

/**
 * Test send to approved internal recipients only. Real provider calls happen exclusively when the
 * provider is LIVE and ALLOW_LIVE_SEND=true; otherwise the exact payload that *would* be sent is
 * returned (dry run). Zoho MA documents no single-recipient test-send API, so email tests are
 * an assisted workflow: preview here, then use "Send test email" inside Zoho.
 */
export async function testSend(campaignId: string, input: { testRecipientIds: string[]; channel: ChannelKey; categoryId: string }, actor: Actor) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, include: { categories: true } });
  if (!campaign) throw notFound("Campaign");
  const cc = campaign.categories.find((c) => c.categoryId === input.categoryId);
  const templateId = input.channel === "EMAIL" ? cc?.emailTemplateId : cc?.whatsappTemplateId;
  if (!cc || !templateId) throw badRequest("Select a template for this category and channel first.");
  const template = await prisma.template.findUniqueOrThrow({ where: { id: templateId } });
  const recipients = await prisma.internalTestRecipient.findMany({ where: { id: { in: input.testRecipientIds }, isActive: true } });
  if (recipients.length !== input.testRecipientIds.length) throw forbidden("Test sends are limited to approved internal test recipients.");
  const results: { recipient: string; outcome: string; detail?: unknown }[] = [];
  const { getWhatsAppProvider } = await import("@/lib/providers/registry");
  for (const r of recipients) {
    const [first, ...rest] = r.name.split(" ");
    const out = renderTemplate(toRenderable(template), { client: { firstName: first, lastName: rest.join(" "), fullName: r.name, email: r.email }, campaign: { name: campaign.name } });
    if (input.channel === "WHATSAPP") {
      if (!r.phoneE164) {
        results.push({ recipient: r.name, outcome: "skipped", detail: "No phone number" });
        continue;
      }
      const dt = await loadIntegration("DOUBLETICK");
      if (dt.mode === "LIVE" && env().ALLOW_LIVE_SEND && out.whatsapp) {
        const { provider } = await getWhatsAppProvider();
        const res = await provider.sendTemplate({ from: dt.config.senderNumber ?? "", to: r.phoneE164, content: out.whatsapp, customData: { nccTest: "1", nccCampaignId: campaignId } });
        results.push({ recipient: r.name, outcome: res.kind === "accepted" ? "accepted_by_provider" : "failed", detail: res.kind === "accepted" ? { messageId: res.messageId } : res });
      } else {
        results.push({ recipient: r.name, outcome: "dry_run_not_sent", detail: { mode: dt.mode, payload: { from: dt.config.senderNumber ?? "(sender not set)", to: r.phoneE164, content: out.whatsapp } } });
      }
    } else {
      results.push({ recipient: r.name, outcome: "assisted_manual", detail: { subject: out.subject, html: out.body, instruction: "Zoho Marketing Automation does not document a single-recipient test-send API. Preview here, then use Zoho's 'Send test email' on the provider campaign." } });
    }
  }
  await prisma.campaign.update({ where: { id: campaignId }, data: { testSendCount: { increment: 1 } } });
  await audit({ actor, action: "campaign.test_send", entityType: "campaign", entityId: campaignId, campaignId, metadata: { channel: input.channel, categoryId: input.categoryId, recipients: recipients.map((r) => r.id), outcomes: results.map((r) => r.outcome) } });
  return results;
}
