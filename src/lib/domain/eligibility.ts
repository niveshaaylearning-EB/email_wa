/**
 * Audience eligibility & overlap resolution engine.
 *
 * Pure and deterministic: given the selected categories (with explicit priorities and
 * per-channel template mappings), current memberships, consent state, suppression list and
 * reviewer decisions, it produces the exact recipient → (channel, category, template) plan.
 * The same function powers the live audience preview, dry runs and the frozen snapshot, so
 * what an approver sees is exactly what gets queued.
 */
import { sha256 } from "../crypto";

export type ChannelKey = "EMAIL" | "WHATSAPP";
export type OverlapStrategyKey = "PRIORITY" | "PER_CATEGORY" | "EXCLUDE_CONFLICTS" | "MANUAL_REVIEW";
export type ConsentPolicy = "OPT_IN" | "OPT_OUT";
export type ExclusionReasonKey =
  | "MISSING_EMAIL"
  | "MISSING_PHONE"
  | "INVALID_EMAIL"
  | "INVALID_PHONE"
  | "UNSUBSCRIBED"
  | "NO_CONSENT"
  | "SUPPRESSED"
  | "CRM_OPT_OUT"
  | "CONFLICT_EXCLUDED"
  | "CONFLICT_UNRESOLVED"
  | "CLIENT_INACTIVE"
  | "DUPLICATE_IDENTITY"
  | "MISSING_TEMPLATE_DATA";

export interface SelectedCategory {
  categoryId: string;
  priority: number; // 1 = highest
  templates: Partial<Record<ChannelKey, string | null>>; // templateId per channel
}

export interface AudienceClient {
  id: string;
  fullName: string;
  emailRaw: string | null;
  emailNormalized: string | null;
  phoneRaw: string | null;
  phoneE164: string | null;
  phoneValid: boolean;
  crmEmailOptOut: boolean;
  crmStatus: string | null;
  deletedInCrmAt: Date | null;
  duplicateOfId: string | null;
}

export interface AudienceMember {
  client: AudienceClient;
  /** Selected-category IDs this client is an active member of. */
  categoryIds: string[];
}

export type ConsentState = Partial<Record<ChannelKey, "GRANTED" | "REVOKED">>;

/** Reviewer decision for a client with conflicting templates on a channel. */
export type ReviewDecision = { categoryId: string } | { exclude: true };

export interface EligibilityInput {
  campaignId: string;
  channels: ChannelKey[];
  strategy: OverlapStrategyKey;
  categories: SelectedCategory[];
  members: AudienceMember[];
  consents: Map<string, ConsentState>;
  /** Normalized identifiers: "EMAIL:x@y.com", "WHATSAPP:+91…", or "ALL:<identifier>". */
  suppressions: Set<string>;
  consentPolicy: Record<ChannelKey, ConsentPolicy>;
  inactiveCrmStatuses: string[];
  reviewDecisions?: Map<string, Partial<Record<ChannelKey, ReviewDecision>>>;
  /** Optional per-recipient template data check (returns missing required variable keys). */
  missingTemplateData?: (clientId: string, templateId: string) => string[];
}

export interface PlannedAssignment {
  channel: ChannelKey;
  categoryId: string;
  templateId: string;
  status: "PLANNED" | "NEEDS_REVIEW" | "EXCLUDED";
  idempotencyKey: string;
  reasons: ExclusionReasonKey[];
  conflictCategoryIds?: string[];
}

export interface ChannelDecision {
  allowed: boolean;
  reasons: ExclusionReasonKey[];
  consent: "GRANTED" | "REVOKED" | "NONE";
  policy: ConsentPolicy;
}

export interface RecipientPlan {
  clientId: string;
  status: "ELIGIBLE" | "EXCLUDED" | "NEEDS_REVIEW";
  exclusionReasons: ExclusionReasonKey[];
  matchedCategoryIds: string[];
  channelDecisions: Partial<Record<ChannelKey, ChannelDecision>>;
  assignments: PlannedAssignment[];
}

export interface AudienceSummary {
  totalMemberships: number;
  uniqueClients: number;
  overlappingClients: number;
  missingEmail: number;
  missingPhone: number;
  unsubscribed: number;
  suppressed: number;
  noConsent: number;
  inactive: number;
  duplicates: number;
  conflicts: number;
  needsReview: number;
  eligibleRecipients: number;
  excludedRecipients: number;
  messageVolume: number;
  perChannel: Record<ChannelKey, { planned: number; excluded: number; needsReview: number }>;
  /** Clients passing contact/consent/suppression checks per channel (independent of templates). */
  contactableByChannel: Record<ChannelKey, number>;
  perCategory: Record<string, { members: number; planned: number }>;
  perTemplate: Record<string, number>;
  exclusionCounts: Partial<Record<ExclusionReasonKey, number>>;
}

export interface EligibilityResult {
  recipients: RecipientPlan[];
  summary: AudienceSummary;
}

export function assignmentIdempotencyKey(
  campaignId: string,
  clientId: string,
  channel: ChannelKey,
  templateId: string,
): string {
  return sha256(`ncc:${campaignId}:${clientId}:${channel}:${templateId}`);
}

function contactFor(client: AudienceClient, channel: ChannelKey): string | null {
  return channel === "EMAIL" ? client.emailNormalized : client.phoneValid ? client.phoneE164 : null;
}

export function computeEligibility(input: EligibilityInput): EligibilityResult {
  const categoryById = new Map(input.categories.map((c) => [c.categoryId, c]));
  const byPriority = (a: string, b: string) =>
    (categoryById.get(a)?.priority ?? 1e9) - (categoryById.get(b)?.priority ?? 1e9) || a.localeCompare(b);
  const inactive = new Set(input.inactiveCrmStatuses.map((s) => s.toLowerCase()));

  // Deterministic order: stable by client id so identity dedupe is reproducible.
  const members = [...input.members].sort((a, b) => a.client.id.localeCompare(b.client.id));
  const seenContacts: Record<ChannelKey, Set<string>> = { EMAIL: new Set(), WHATSAPP: new Set() };

  const summary: AudienceSummary = {
    totalMemberships: 0,
    uniqueClients: 0,
    overlappingClients: 0,
    missingEmail: 0,
    missingPhone: 0,
    unsubscribed: 0,
    suppressed: 0,
    noConsent: 0,
    inactive: 0,
    duplicates: 0,
    conflicts: 0,
    needsReview: 0,
    eligibleRecipients: 0,
    excludedRecipients: 0,
    messageVolume: 0,
    perChannel: {
      EMAIL: { planned: 0, excluded: 0, needsReview: 0 },
      WHATSAPP: { planned: 0, excluded: 0, needsReview: 0 },
    },
    contactableByChannel: { EMAIL: 0, WHATSAPP: 0 },
    perCategory: Object.fromEntries(input.categories.map((c) => [c.categoryId, { members: 0, planned: 0 }])),
    perTemplate: {},
    exclusionCounts: {},
  };

  const recipients: RecipientPlan[] = [];

  for (const { client, categoryIds } of members) {
    const matched = [...new Set(categoryIds.filter((id) => categoryById.has(id)))].sort(byPriority);
    if (matched.length === 0) continue;
    summary.totalMemberships += matched.length;
    summary.uniqueClients += 1;
    if (matched.length > 1) summary.overlappingClients += 1;
    for (const id of matched) summary.perCategory[id].members += 1;

    const clientReasons: ExclusionReasonKey[] = [];
    if (client.deletedInCrmAt || (client.crmStatus && inactive.has(client.crmStatus.toLowerCase()))) {
      clientReasons.push("CLIENT_INACTIVE");
    }
    if (client.duplicateOfId) clientReasons.push("DUPLICATE_IDENTITY");

    const plan: RecipientPlan = {
      clientId: client.id,
      status: "EXCLUDED",
      exclusionReasons: [],
      matchedCategoryIds: matched,
      channelDecisions: {},
      assignments: [],
    };

    for (const channel of input.channels) {
      const reasons: ExclusionReasonKey[] = [...clientReasons];
      const contact = contactFor(client, channel);
      if (channel === "EMAIL" && !client.emailNormalized) {
        reasons.push(client.emailRaw?.trim() ? "INVALID_EMAIL" : "MISSING_EMAIL");
      }
      if (channel === "WHATSAPP" && !(client.phoneValid && client.phoneE164)) {
        reasons.push(client.phoneRaw?.trim() ? "INVALID_PHONE" : "MISSING_PHONE");
      }
      if (channel === "EMAIL" && client.crmEmailOptOut) reasons.push("CRM_OPT_OUT");

      const consent = input.consents.get(client.id)?.[channel];
      const policy = input.consentPolicy[channel];
      if (consent === "REVOKED") reasons.push("UNSUBSCRIBED");
      else if (policy === "OPT_IN" && consent !== "GRANTED") reasons.push("NO_CONSENT");

      if (
        contact &&
        (input.suppressions.has(`${channel}:${contact}`) || input.suppressions.has(`ALL:${contact}`))
      ) {
        reasons.push("SUPPRESSED");
      }
      if (contact && reasons.length === 0) {
        if (seenContacts[channel].has(contact)) reasons.push("DUPLICATE_IDENTITY");
      }

      plan.channelDecisions[channel] = {
        allowed: reasons.length === 0,
        reasons,
        consent: consent ?? "NONE",
        policy,
      };
      if (reasons.length === 0) summary.contactableByChannel[channel] += 1;

      // Template resolution across matched categories.
      const withTemplate = matched.filter((id) => categoryById.get(id)?.templates[channel]);
      if (withTemplate.length === 0) continue; // validation guarantees templates; defensive only
      const templateToCategories = new Map<string, string[]>();
      for (const id of withTemplate) {
        const t = categoryById.get(id)!.templates[channel]!;
        templateToCategories.set(t, [...(templateToCategories.get(t) ?? []), id]);
      }
      const distinct = [...templateToCategories.entries()].map(([templateId, cats]) => ({
        templateId,
        categoryId: cats.sort(byPriority)[0],
      }));
      distinct.sort((a, b) => byPriority(a.categoryId, b.categoryId));

      const mk = (
        categoryId: string,
        templateId: string,
        status: PlannedAssignment["status"],
        extra: ExclusionReasonKey[] = [],
        conflictCategoryIds?: string[],
      ): PlannedAssignment => ({
        channel,
        categoryId,
        templateId,
        // Channel-level exclusions (contact, consent, suppression) always win over review/plan.
        status: reasons.length > 0 || extra.length > 0 ? "EXCLUDED" : status,
        idempotencyKey: assignmentIdempotencyKey(input.campaignId, client.id, channel, templateId),
        reasons: [...reasons, ...extra],
        conflictCategoryIds,
      });

      let chosen: PlannedAssignment[];
      if (distinct.length === 1) {
        chosen = [mk(distinct[0].categoryId, distinct[0].templateId, "PLANNED")];
      } else {
        summary.conflicts += 1;
        const conflictIds = distinct.map((d) => d.categoryId);
        switch (input.strategy) {
          case "PRIORITY":
            chosen = [mk(distinct[0].categoryId, distinct[0].templateId, "PLANNED")];
            break;
          case "PER_CATEGORY":
            chosen = distinct.map((d) => mk(d.categoryId, d.templateId, "PLANNED"));
            break;
          case "EXCLUDE_CONFLICTS":
            chosen = [mk(distinct[0].categoryId, distinct[0].templateId, "EXCLUDED", ["CONFLICT_EXCLUDED"], conflictIds)];
            break;
          case "MANUAL_REVIEW":
          default: {
            const decision = input.reviewDecisions?.get(client.id)?.[channel];
            if (decision && "exclude" in decision) {
              chosen = [mk(distinct[0].categoryId, distinct[0].templateId, "EXCLUDED", ["CONFLICT_EXCLUDED"], conflictIds)];
            } else if (decision && "categoryId" in decision && distinct.some((d) => d.categoryId === decision.categoryId)) {
              const d = distinct.find((x) => x.categoryId === decision.categoryId)!;
              chosen = [mk(d.categoryId, d.templateId, "PLANNED")];
            } else {
              chosen = [mk(distinct[0].categoryId, distinct[0].templateId, "NEEDS_REVIEW", [], conflictIds)];
              if (reasons.length === 0) chosen[0].reasons = ["CONFLICT_UNRESOLVED"];
            }
          }
        }
      }

      // Per-recipient template data (e.g. required placeholder missing for this client).
      if (input.missingTemplateData) {
        for (const a of chosen) {
          if (a.status === "PLANNED" && input.missingTemplateData(client.id, a.templateId).length > 0) {
            a.status = "EXCLUDED";
            a.reasons.push("MISSING_TEMPLATE_DATA");
          }
        }
      }

      if (chosen.some((a) => a.status === "PLANNED") && contact) seenContacts[channel].add(contact);
      plan.assignments.push(...chosen);
    }

    const planned = plan.assignments.filter((a) => a.status === "PLANNED");
    const review = plan.assignments.filter((a) => a.status === "NEEDS_REVIEW");
    plan.status = planned.length > 0 ? "ELIGIBLE" : review.length > 0 ? "NEEDS_REVIEW" : "EXCLUDED";
    const allReasons = new Set<ExclusionReasonKey>();
    for (const d of Object.values(plan.channelDecisions)) d?.reasons.forEach((r) => allReasons.add(r));
    for (const a of plan.assignments) a.reasons.forEach((r) => allReasons.add(r));
    plan.exclusionReasons = [...allReasons].sort();

    // Summary
    for (const r of allReasons) summary.exclusionCounts[r] = (summary.exclusionCounts[r] ?? 0) + 1;
    if (allReasons.has("MISSING_EMAIL") || allReasons.has("INVALID_EMAIL")) summary.missingEmail += 1;
    if (allReasons.has("MISSING_PHONE") || allReasons.has("INVALID_PHONE")) summary.missingPhone += 1;
    if (allReasons.has("UNSUBSCRIBED") || allReasons.has("CRM_OPT_OUT")) summary.unsubscribed += 1;
    if (allReasons.has("SUPPRESSED")) summary.suppressed += 1;
    if (allReasons.has("NO_CONSENT")) summary.noConsent += 1;
    if (allReasons.has("CLIENT_INACTIVE")) summary.inactive += 1;
    if (allReasons.has("DUPLICATE_IDENTITY")) summary.duplicates += 1;
    if (plan.status === "ELIGIBLE") summary.eligibleRecipients += 1;
    else if (plan.status === "NEEDS_REVIEW") summary.needsReview += 1;
    else summary.excludedRecipients += 1;
    for (const a of plan.assignments) {
      const bucket = summary.perChannel[a.channel];
      if (a.status === "PLANNED") {
        bucket.planned += 1;
        summary.messageVolume += 1;
        summary.perCategory[a.categoryId].planned += 1;
        summary.perTemplate[a.templateId] = (summary.perTemplate[a.templateId] ?? 0) + 1;
      } else if (a.status === "NEEDS_REVIEW") bucket.needsReview += 1;
      else bucket.excluded += 1;
    }

    recipients.push(plan);
  }

  return { recipients, summary };
}

export function channelsFor(mode: "EMAIL" | "WHATSAPP" | "BOTH"): ChannelKey[] {
  return mode === "BOTH" ? ["EMAIL", "WHATSAPP"] : [mode];
}

export { EXCLUSION_LABELS } from "./labels";
