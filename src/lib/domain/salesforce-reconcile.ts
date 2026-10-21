/**
 * Audience ↔ send-tracking reconciliation (pure, deterministic, no I/O).
 *
 * Evidence discipline:
 *   - MATCHED_SENT means a SentEvent exists for the identity. A SentEvent shows Salesforce
 *     processed a send for that subscriber; it does NOT prove inbox delivery.
 *   - "No observed SentEvent" is split by the strength of the evidence available:
 *       AUDIENCE_NO_SENT_EVENT + flag NOTSENT_EVENT     → recipient-level NotSentEvent exists (verified)
 *       AUDIENCE_NO_SENT_EVENT + circumstantial flags   → possible explanation only (current
 *                                                         subscriber status, current exclusion
 *                                                         snapshot, earlier unsubscribe event)
 *       UNRESOLVED                                      → no evidence either way
 *       RETENTION_UNAVAILABLE                           → send tracking not retrievable / not archived
 *   - Nothing is ever inferred as suppressed, excluded or not-sent without evidence.
 */

export type ReconClass = "MATCHED_SENT" | "AUDIENCE_NO_SENT_EVENT" | "TRACKING_NOT_IN_AUDIENCE" | "DUPLICATE_AUDIENCE_ROW" | "INVALID_IDENTIFIER" | "RETENTION_UNAVAILABLE" | "UNRESOLVED";

export const RECON_CLASS_LABELS: Record<ReconClass, string> = {
  MATCHED_SENT: "In audience and observed in send tracking",
  AUDIENCE_NO_SENT_EVENT: "In audience, no SentEvent — evidence found",
  UNRESOLVED: "In audience, no SentEvent — unresolved (no evidence)",
  TRACKING_NOT_IN_AUDIENCE: "Observed in send tracking, not in supplied audience",
  DUPLICATE_AUDIENCE_ROW: "Duplicate audience row",
  INVALID_IDENTIFIER: "Missing or invalid identifier",
  RETENTION_UNAVAILABLE: "Send tracking not retrievable (retention / not archived)",
};

export const RECON_FLAG_LABELS: Record<string, string> = {
  BOUNCE_EVENT: "BounceEvent recorded for this job",
  UNSUB_EVENT: "UnsubEvent recorded for this job",
  NOTSENT_EVENT: "NotSentEvent recorded for this job (recipient-level evidence)",
  UNSUB_EVENT_BEFORE_SEND: "UnsubEvent in an earlier job, dated before this send (possible explanation)",
  EXCLUSION_SNAPSHOT_MEMBER: "Present in a supplied exclusion/suppression snapshot (current state — possible explanation)",
  EMAIL_NOT_IN_SUBSCRIBER_ARCHIVE: "Email not found in the archived subscriber list (cannot map to a SubscriberKey)",
  AMBIGUOUS_EMAIL_MAPPING: "Email maps to more than one SubscriberKey",
  TRACKING_PARTIAL: "Send tracking unavailable for some of the selected jobs",
};

export interface EventRef {
  subscriberKey: string | null;
  jobId: string | null;
  eventDate: Date | null;
  sourceEventType?: string | null;
}

export interface ReconInput {
  audience: { ref: { page: number; row: number }; value: string | null }[];
  mode: "SUBSCRIBER_KEY" | "EMAIL";
  caseInsensitive: boolean;
  trim: boolean;
  /** EMAIL mode: normalised email → SubscriberKeys from the archived subscriber list. */
  emailToKeys?: Map<string, string[]>;
  sent: EventRef[];
  notSent: EventRef[];
  bounces: EventRef[];
  unsubs: EventRef[];
  /** UnsubEvents from other jobs (for "unsubscribed before send" evidence). */
  otherUnsubs?: EventRef[];
  /** Current subscriber status from the archive (normalised key → status). */
  subscriberStatus?: Map<string, string | null>;
  /** Normalised identities present in supplied exclusion snapshots. */
  exclusionMembers?: Set<string>;
  /** "AVAILABLE" — tracking archived for every job; "PARTIAL" — some; "UNAVAILABLE" — none. */
  trackingAvailability: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
  /** Earliest send time of the selected jobs (for "unsubscribed before send"). */
  sendDate?: Date | null;
}

export interface ReconResultRow {
  identity: string | null;
  rawIdentity: string | null;
  classification: ReconClass;
  flags: string[];
  audienceRefs: { page: number; row: number }[];
  sentEventCount: number;
  firstSentAt: Date | null;
  evidence: Record<string, unknown>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeIdentity(v: string | null | undefined, opts: { trim: boolean; caseInsensitive: boolean }): string | null {
  if (v === null || v === undefined) return null;
  let s = opts.trim ? v.trim() : v;
  if (opts.caseInsensitive) s = s.toLowerCase();
  return s.length ? s : null;
}

function groupBy(events: EventRef[], norm: (v: string | null) => string | null) {
  const m = new Map<string, EventRef[]>();
  for (const e of events) {
    const k = norm(e.subscriberKey);
    if (!k) continue;
    let arr = m.get(k);
    if (!arr) m.set(k, (arr = []));
    arr.push(e);
  }
  return m;
}

export function reconcile(input: ReconInput) {
  const keyNorm = (v: string | null) => normalizeIdentity(v, { trim: input.trim, caseInsensitive: input.caseInsensitive });
  const sentBy = groupBy(input.sent, keyNorm);
  const notSentBy = groupBy(input.notSent, keyNorm);
  const bounceBy = groupBy(input.bounces, keyNorm);
  const unsubBy = groupBy(input.unsubs, keyNorm);
  const otherUnsubBy = groupBy(input.otherUnsubs ?? [], keyNorm);

  const results: ReconResultRow[] = [];
  const firstSeen = new Map<string, ReconResultRow>();
  const matchedKeys = new Set<string>();

  for (const row of input.audience) {
    const raw = row.value;
    // Resolve the audience value to a SubscriberKey-space identity.
    let identity: string | null;
    const flags: string[] = [];
    let candidates: string[] = [];
    if (input.mode === "EMAIL") {
      const email = raw?.trim().toLowerCase() ?? "";
      if (!email || !EMAIL_RE.test(email)) {
        results.push({ identity: null, rawIdentity: raw, classification: "INVALID_IDENTIFIER", flags: [], audienceRefs: [row.ref], sentEventCount: 0, firstSentAt: null, evidence: { reason: email ? "not a valid email address" : "empty" } });
        continue;
      }
      identity = email;
      candidates = (input.emailToKeys?.get(email) ?? []).map((k) => keyNorm(k)).filter((k): k is string => !!k);
      if (!candidates.length) flags.push("EMAIL_NOT_IN_SUBSCRIBER_ARCHIVE");
      if (candidates.length > 1) flags.push("AMBIGUOUS_EMAIL_MAPPING");
    } else {
      identity = keyNorm(raw);
      if (!identity) {
        results.push({ identity: null, rawIdentity: raw, classification: "INVALID_IDENTIFIER", flags: [], audienceRefs: [row.ref], sentEventCount: 0, firstSentAt: null, evidence: { reason: "empty SubscriberKey" } });
        continue;
      }
      candidates = [identity];
    }

    const prior = firstSeen.get(identity);
    if (prior) {
      results.push({ identity, rawIdentity: raw, classification: "DUPLICATE_AUDIENCE_ROW", flags: [], audienceRefs: [row.ref], sentEventCount: 0, firstSentAt: null, evidence: { firstOccurrence: prior.audienceRefs[0] } });
      continue;
    }

    const sentEvents = candidates.flatMap((k) => sentBy.get(k) ?? []);
    const result: ReconResultRow = { identity, rawIdentity: raw, classification: "UNRESOLVED", flags, audienceRefs: [row.ref], sentEventCount: sentEvents.length, firstSentAt: null, evidence: {} };
    if (input.mode === "EMAIL") result.evidence.mappedSubscriberKeys = candidates;

    if (sentEvents.length) {
      result.classification = "MATCHED_SENT";
      const dates = sentEvents.map((e) => e.eventDate).filter((d): d is Date => !!d);
      result.firstSentAt = dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
      result.evidence.sentJobs = [...new Set(sentEvents.map((e) => e.jobId))];
      candidates.forEach((k) => matchedKeys.add(k));
      if (candidates.some((k) => bounceBy.has(k))) flags.push("BOUNCE_EVENT");
      if (candidates.some((k) => unsubBy.has(k))) flags.push("UNSUB_EVENT");
      if (input.trackingAvailability === "PARTIAL") flags.push("TRACKING_PARTIAL");
    } else if (input.trackingAvailability === "UNAVAILABLE") {
      result.classification = "RETENTION_UNAVAILABLE";
    } else {
      const ns = candidates.flatMap((k) => notSentBy.get(k) ?? []);
      if (ns.length) {
        flags.push("NOTSENT_EVENT");
        result.evidence.notSentEventTypes = [...new Set(ns.map((e) => e.sourceEventType ?? "NotSent"))];
      }
      const statuses = candidates.map((k) => input.subscriberStatus?.get(k)).filter((s): s is string => !!s && s.toLowerCase() !== "active");
      for (const s of new Set(statuses)) flags.push(`SUBSCRIBER_STATUS_${s.toUpperCase().replace(/[^A-Z]/g, "_")}`);
      if (statuses.length) result.evidence.currentSubscriberStatus = statuses[0];
      if (input.sendDate) {
        const earlier = candidates.flatMap((k) => otherUnsubBy.get(k) ?? []).filter((e) => e.eventDate && e.eventDate < input.sendDate!);
        if (earlier.length) {
          flags.push("UNSUB_EVENT_BEFORE_SEND");
          result.evidence.earlierUnsub = { jobId: earlier[0].jobId, eventDate: earlier[0].eventDate?.toISOString() };
        }
      }
      if (candidates.some((k) => input.exclusionMembers?.has(k))) flags.push("EXCLUSION_SNAPSHOT_MEMBER");
      if (input.trackingAvailability === "PARTIAL") flags.push("TRACKING_PARTIAL");
      const verified = flags.includes("NOTSENT_EVENT");
      const possible = flags.some((f) => f.startsWith("SUBSCRIBER_STATUS_") || f === "UNSUB_EVENT_BEFORE_SEND" || f === "EXCLUSION_SNAPSHOT_MEMBER");
      result.classification = verified || possible ? "AUDIENCE_NO_SENT_EVENT" : "UNRESOLVED";
      result.evidence.evidenceLevel = verified ? "VERIFIED_RECIPIENT_EVENT" : possible ? "POSSIBLE_EXPLANATION_ONLY" : "NONE";
    }
    firstSeen.set(identity, result);
    results.push(result);
  }

  // SentEvents for subscribers absent from the supplied audience.
  for (const [k, events] of sentBy) {
    if (matchedKeys.has(k)) continue;
    const dates = events.map((e) => e.eventDate).filter((d): d is Date => !!d);
    const f: string[] = [];
    if (bounceBy.has(k)) f.push("BOUNCE_EVENT");
    if (unsubBy.has(k)) f.push("UNSUB_EVENT");
    results.push({
      identity: k,
      rawIdentity: events[0].subscriberKey,
      classification: "TRACKING_NOT_IN_AUDIENCE",
      flags: f,
      audienceRefs: [],
      sentEventCount: events.length,
      firstSentAt: dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null,
      evidence: { sentJobs: [...new Set(events.map((e) => e.jobId))] },
    });
  }

  return { results, summary: summarize(input, results, sentBy) };
}

function summarize(input: ReconInput, results: ReconResultRow[], sentBy: Map<string, EventRef[]>) {
  const byClass = Object.fromEntries((Object.keys(RECON_CLASS_LABELS) as ReconClass[]).map((c) => [c, 0])) as Record<ReconClass, number>;
  const flagCounts: Record<string, number> = {};
  for (const r of results) {
    byClass[r.classification] += 1;
    for (const f of r.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;
  }
  const audienceRows = input.audience.length;
  const uniqueValid = audienceRows - byClass.DUPLICATE_AUDIENCE_ROW - byClass.INVALID_IDENTIFIER;
  const withVerified = results.filter((r) => r.classification === "AUDIENCE_NO_SENT_EVENT" && r.flags.includes("NOTSENT_EVENT")).length;
  return {
    audienceRows,
    uniqueAudienceIdentities: uniqueValid,
    duplicateAudienceRows: byClass.DUPLICATE_AUDIENCE_ROW,
    invalidIdentifiers: byClass.INVALID_IDENTIFIER,
    observedSentEvents: input.sent.length,
    uniqueRecipientsWithSentEvent: sentBy.size,
    observedNotSentEvents: input.notSent.length,
    observedBounceEvents: input.bounces.length,
    observedUnsubEvents: input.unsubs.length,
    matched: byClass.MATCHED_SENT,
    audienceWithoutSentEvent: byClass.AUDIENCE_NO_SENT_EVENT + byClass.UNRESOLVED + byClass.RETENTION_UNAVAILABLE,
    withVerifiedNotSentEvidence: withVerified,
    withPossibleExplanationOnly: byClass.AUDIENCE_NO_SENT_EVENT - withVerified,
    unresolved: byClass.UNRESOLVED,
    retentionUnavailable: byClass.RETENTION_UNAVAILABLE,
    trackingNotInAudience: byClass.TRACKING_NOT_IN_AUDIENCE,
    byClass,
    flagCounts,
    /** Arithmetic bridge from audience rows to unique recipients with a SentEvent. */
    bridge: [
      { label: "Audience rows", value: audienceRows },
      { label: "- Duplicate audience rows", value: -byClass.DUPLICATE_AUDIENCE_ROW },
      { label: "- Missing/invalid identifiers", value: -byClass.INVALID_IDENTIFIER },
      { label: "= Unique audience identities", value: uniqueValid, subtotal: true },
      { label: "- No SentEvent: recipient-level NotSentEvent", value: -withVerified },
      { label: "- No SentEvent: possible explanation only", value: -(byClass.AUDIENCE_NO_SENT_EVENT - withVerified) },
      { label: "- No SentEvent: unresolved", value: -byClass.UNRESOLVED },
      { label: "- No SentEvent: tracking not retrievable", value: -byClass.RETENTION_UNAVAILABLE },
      { label: "= Audience identities with a SentEvent", value: byClass.MATCHED_SENT, subtotal: true },
      { label: "+ SentEvents for identities not in the audience", value: byClass.TRACKING_NOT_IN_AUDIENCE },
      { label: "= Unique recipients with a SentEvent", value: byClass.MATCHED_SENT + byClass.TRACKING_NOT_IN_AUDIENCE, subtotal: true },
    ],
  };
}
export type ReconSummary = ReturnType<typeof summarize>;
