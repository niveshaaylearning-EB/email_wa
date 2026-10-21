/**
 * Reconciliation runs (e.g. "the DE had ~18,000 rows but Sends shows ~16,000").
 * Loads the audience dataset, the CURRENT tracking datasets of the selected JobIDs and the
 * optional evidence sources, runs the pure classifier, and freezes the results (a DB trigger
 * makes completed reconciliations immutable — re-runs create a new reconciliation).
 */
import "server-only";
import { z } from "zod";
import type { Prisma, SalesforceBackupDataset } from "@prisma/client";
import { prisma } from "@/lib/db";
import { badRequest, notFound } from "@/lib/errors";
import { enqueue } from "@/lib/queue";
import { stableHash } from "@/lib/crypto";
import { reconcile, normalizeIdentity, type EventRef } from "@/lib/domain/salesforce-reconcile";
import { parseSettings } from "./connections";
import { archiveAudit, archiveCode, type ArchiveActor } from "./audit";
import type { DatasetParams } from "./types";

export const ReconciliationRequestSchema = z
  .object({
    name: z.string().trim().min(3).max(150),
    mid: z.string().regex(/^\d{1,12}$/),
    jobIds: z.array(z.string().regex(/^\d{1,15}$/)).min(1).max(20),
    audienceDatasetId: z.string().min(1),
    audienceField: z.string().min(1).max(200),
    identityMode: z.enum(["SUBSCRIBER_KEY", "EMAIL"]).default("SUBSCRIBER_KEY"),
    caseInsensitive: z.boolean().default(false),
    trim: z.boolean().default(true),
    sendDateFrom: z.string().datetime().optional(),
    sendDateTo: z.string().datetime().optional(),
    exclusionDatasetIds: z.array(z.string()).max(10).default([]),
    exclusionField: z.string().max(200).default("SubscriberKey"),
    /** Claim the audience is the historical send-time audience. Requires evidence. */
    historicalClaim: z
      .object({
        evidence: z.string().trim().min(20, "Describe the evidence (at least 20 characters)").max(2000),
        attest: z.literal(true),
      })
      .optional(),
  })
  .refine((v) => !v.sendDateFrom || !v.sendDateTo || v.sendDateFrom <= v.sendDateTo, { message: "Date range is reversed", path: ["sendDateTo"] });
export type ReconciliationRequest = z.infer<typeof ReconciliationRequestSchema>;

type LoadedEvent = EventRef & { fingerprint: string };

const TRACKING_KINDS = ["TRACKING_SENT", "TRACKING_NOTSENT", "TRACKING_BOUNCE", "TRACKING_UNSUB"] as const;

/** Latest authoritative dataset per (kind, JobID): not superseded, extracted or not-retrievable. */
export async function currentTrackingDatasets(mid: string, jobIds: string[], kinds: readonly string[] = TRACKING_KINDS) {
  return prisma.salesforceBackupDataset.findMany({
    where: { mid, kind: { in: kinds as never }, sourceKey: { in: jobIds }, supersededById: null, status: { in: ["EXTRACTED", "NOT_RETRIEVABLE"] } },
    orderBy: { createdAt: "desc" },
  });
}

export async function createReconciliation(input: ReconciliationRequest, actor: ArchiveActor) {
  const audience = await prisma.salesforceBackupDataset.findUnique({ where: { id: input.audienceDatasetId } });
  if (!audience || !["DE_ROWS", "AUDIENCE_UPLOAD"].includes(audience.kind)) throw notFound("Audience dataset");
  if (!audience.sealedAt || audience.status !== "EXTRACTED") throw badRequest("The audience dataset must be fully extracted and sealed.");
  const params = audience.params as unknown as DatasetParams;
  const fields = params.schema?.map((f) => f.name) ?? [];
  if (fields.length && !fields.includes(input.audienceField)) throw badRequest(`Field "${input.audienceField}" is not in the audience schema (${fields.join(", ")}).`);
  for (const id of input.exclusionDatasetIds) {
    const ex = await prisma.salesforceBackupDataset.findUnique({ where: { id } });
    if (!ex || !["DE_ROWS", "AUDIENCE_UPLOAD"].includes(ex.kind) || !ex.sealedAt) throw badRequest("Exclusion snapshots must be sealed Data Extension or upload datasets.");
  }
  const jobs = await prisma.salesforceEmailJob.findMany({ where: { mid: input.mid, jobId: { in: input.jobIds } } });
  const firstSend = jobs.map((j) => j.sentDate ?? j.sendDate).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const extractedAt = audience.finishedAt;
  const isUpload = audience.kind === "AUDIENCE_UPLOAD";
  const uploadHistorical = isUpload && params.upload?.label === "HISTORICAL_EVIDENCED";
  const label = input.historicalClaim || uploadHistorical ? "HISTORICAL_EVIDENCED" : "CURRENT_STATE";
  const evidence = {
    claim: input.historicalClaim?.evidence ?? (uploadHistorical ? params.upload?.evidenceNote : null) ?? null,
    attestedBy: input.historicalClaim ? actor.email : uploadHistorical ? "uploader" : null,
    attestedAt: input.historicalClaim ? new Date().toISOString() : null,
    audienceExtractedAt: extractedAt?.toISOString() ?? null,
    uploadSnapshotDate: params.upload?.snapshotDate ?? null,
    firstSendAt: firstSend?.toISOString() ?? null,
    extractedAfterSend: !!(extractedAt && firstSend && extractedAt > firstSend),
  };
  const rec = await prisma.salesforceReconciliationJob.create({
    data: {
      code: archiveCode("REC"),
      name: input.name,
      connectionId: audience.connectionId,
      mid: input.mid,
      jobIds: input.jobIds,
      sendDateFrom: input.sendDateFrom ? new Date(input.sendDateFrom) : null,
      sendDateTo: input.sendDateTo ? new Date(input.sendDateTo) : null,
      audienceDatasetId: audience.id,
      audienceSource: isUpload ? "UPLOAD" : "DE_BACKUP",
      audienceLabel: label,
      audienceEvidence: evidence as Prisma.InputJsonValue,
      identityMapping: { field: input.audienceField, mode: input.identityMode, caseInsensitive: input.caseInsensitive, trim: input.trim, exclusionDatasetIds: input.exclusionDatasetIds, exclusionField: input.exclusionField } as Prisma.InputJsonValue,
      isSimulated: audience.isSimulated,
      createdById: actor.id,
      createdByEmail: actor.email,
    },
  });
  await archiveAudit({ actor, action: "archive.reconciliation.created", entityType: "salesforce_reconciliation", entityId: rec.id, metadata: { code: rec.code, jobIds: input.jobIds, audienceDatasetId: audience.id, label } });
  await enqueue("sfmc.reconcile", { reconciliationId: rec.id }, { jobId: `sfmc-recon-${rec.id}` });
  return rec;
}

async function loadEvents(datasets: SalesforceBackupDataset[], eventType: "SENT" | "NOTSENT" | "BOUNCE" | "UNSUB", window?: { from: Date | null; to: Date | null }): Promise<LoadedEvent[]> {
  const ids = datasets.map((d) => d.id);
  if (!ids.length) return [];
  const out: LoadedEvent[] = [];
  let cursor: bigint | undefined;
  for (;;) {
    const batch = await prisma.salesforceTrackingEvent.findMany({
      where: {
        datasetId: { in: ids },
        eventType,
        ...(window && (window.from || window.to) ? { eventDate: { ...(window.from ? { gte: window.from } : {}), ...(window.to ? { lte: window.to } : {}) } } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true, subscriberKey: true, jobId: true, eventDate: true, sourceEventType: true, fingerprint: true },
      orderBy: { id: "asc" },
      take: 10_000,
    });
    if (!batch.length) break;
    for (const e of batch) out.push({ subscriberKey: e.subscriberKey, jobId: e.jobId, eventDate: e.eventDate, sourceEventType: e.sourceEventType, fingerprint: e.fingerprint });
    cursor = batch[batch.length - 1].id;
  }
  return out;
}

/** Collapse rows Salesforce returned twice (identical fingerprint) for counting purposes. */
function distinct(events: LoadedEvent[]): LoadedEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (seen.has(e.fingerprint)) return false;
    seen.add(e.fingerprint);
    return true;
  });
}

async function datasetValues(datasetId: string, field: string): Promise<{ ref: { page: number; row: number }; value: string | null }[]> {
  const out: { ref: { page: number; row: number }; value: string | null }[] = [];
  let cursor: bigint | undefined;
  for (;;) {
    const batch = await prisma.salesforceDataExtensionRow.findMany({ where: { datasetId, ...(cursor ? { id: { gt: cursor } } : {}) }, select: { id: true, pageNo: true, rowNo: true, values: true }, orderBy: [{ id: "asc" }], take: 10_000 });
    if (!batch.length) break;
    for (const r of batch) {
      const v = (r.values as Record<string, string | null>)[field];
      out.push({ ref: { page: r.pageNo, row: r.rowNo }, value: v === undefined ? null : v });
    }
    cursor = batch[batch.length - 1].id;
  }
  out.sort((a, b) => a.ref.page - b.ref.page || a.ref.row - b.ref.row);
  return out;
}

export async function runReconciliation(id: string) {
  const rec = await prisma.salesforceReconciliationJob.findUnique({ where: { id } });
  if (!rec || rec.status === "COMPLETED") return;
  await prisma.salesforceReconciliationJob.update({ where: { id }, data: { status: "RUNNING", startedAt: new Date() } });
  try {
    await prisma.salesforceReconciliationResult.deleteMany({ where: { reconciliationId: id } }); // partial results of an interrupted run
    const mapping = rec.identityMapping as { field: string; mode: "SUBSCRIBER_KEY" | "EMAIL"; caseInsensitive: boolean; trim: boolean; exclusionDatasetIds: string[]; exclusionField: string };
    const norm = (v: string | null) => normalizeIdentity(v, mapping);
    const audienceDs = await prisma.salesforceBackupDataset.findUniqueOrThrow({ where: { id: rec.audienceDatasetId } });
    const audience = await datasetValues(audienceDs.id, mapping.field);

    const tracking = await currentTrackingDatasets(rec.mid, rec.jobIds);
    const sentDs = tracking.filter((d) => d.kind === "TRACKING_SENT");
    const availableJobs = rec.jobIds.filter((j) => sentDs.some((d) => d.sourceKey === j && d.status === "EXTRACTED"));
    const unavailableJobs = rec.jobIds.filter((j) => !availableJobs.includes(j));
    const trackingAvailability = availableJobs.length === rec.jobIds.length ? "AVAILABLE" : availableJobs.length ? "PARTIAL" : "UNAVAILABLE";
    const window = { from: rec.sendDateFrom, to: rec.sendDateTo };
    const ofKind = (k: string) => tracking.filter((d) => d.kind === k && d.status === "EXTRACTED");
    const [sentRaw, notSentRaw, bounceRaw, unsubRaw] = await Promise.all([loadEvents(ofKind("TRACKING_SENT"), "SENT", window), loadEvents(ofKind("TRACKING_NOTSENT"), "NOTSENT"), loadEvents(ofKind("TRACKING_BOUNCE"), "BOUNCE"), loadEvents(ofKind("TRACKING_UNSUB"), "UNSUB")]);
    const sent = distinct(sentRaw);

    const jobs = await prisma.salesforceEmailJob.findMany({ where: { mid: rec.mid, jobId: { in: rec.jobIds } } });
    const firstSend = jobs.map((j) => j.sentDate ?? j.sendDate).filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

    // Unsubscribes recorded in OTHER jobs before this send (evidence of prior opt-out).
    const otherUnsubDs = await prisma.salesforceBackupDataset.findMany({ where: { mid: rec.mid, kind: "TRACKING_UNSUB", supersededById: null, status: "EXTRACTED", sourceKey: { notIn: rec.jobIds } } });
    const otherUnsubs = firstSend ? (await loadEvents(otherUnsubDs, "UNSUB")).filter((e) => e.eventDate && e.eventDate < firstSend) : [];

    // Current subscriber status (state at extraction time, not necessarily at send time).
    const subsDs = await prisma.salesforceBackupDataset.findFirst({ where: { mid: rec.mid, kind: "SUBSCRIBERS", supersededById: null, status: "EXTRACTED" }, orderBy: { createdAt: "desc" } });
    const subscriberStatus = new Map<string, string | null>();
    const emailToKeys = new Map<string, string[]>();
    if (subsDs) {
      let cursor: bigint | undefined;
      for (;;) {
        const batch = await prisma.salesforceSubscriber.findMany({ where: { datasetId: subsDs.id, ...(cursor ? { id: { gt: cursor } } : {}) }, select: { id: true, subscriberKey: true, emailAddress: true, status: true }, orderBy: { id: "asc" }, take: 20_000 });
        if (!batch.length) break;
        for (const s of batch) {
          const k = norm(s.subscriberKey);
          if (k) subscriberStatus.set(k, s.status);
          const e = s.emailAddress?.trim().toLowerCase();
          if (e && s.subscriberKey) emailToKeys.set(e, [...(emailToKeys.get(e) ?? []), s.subscriberKey]);
        }
        cursor = batch[batch.length - 1].id;
      }
    }

    const exclusionMembers = new Set<string>();
    for (const exId of mapping.exclusionDatasetIds) for (const r of await datasetValues(exId, mapping.exclusionField)) {
      const k = norm(r.value);
      if (k) exclusionMembers.add(k);
    }

    const { results, summary } = reconcile({
      audience,
      mode: mapping.mode,
      caseInsensitive: mapping.caseInsensitive,
      trim: mapping.trim,
      emailToKeys,
      sent,
      notSent: distinct(notSentRaw),
      bounces: distinct(bounceRaw),
      unsubs: distinct(unsubRaw),
      otherUnsubs,
      subscriberStatus,
      exclusionMembers,
      trackingAvailability,
      sendDate: firstSend,
    });

    for (let i = 0; i < results.length; i += 2000) {
      await prisma.salesforceReconciliationResult.createMany({
        data: results.slice(i, i + 2000).map((r) => ({
          reconciliationId: id,
          identity: r.identity,
          rawIdentity: r.rawIdentity,
          classification: r.classification,
          flags: r.flags,
          audienceRefs: r.audienceRefs as Prisma.InputJsonValue,
          sentEventCount: r.sentEventCount,
          firstSentAt: r.firstSentAt,
          evidence: r.evidence as Prisma.InputJsonValue,
        })),
      });
    }

    const conn = rec.connectionId ? await prisma.salesforceConnection.findUnique({ where: { id: rec.connectionId } }) : null;
    const settings = parseSettings(conn?.settings);
    const evidence = rec.audienceEvidence as Record<string, unknown>;
    const manifests = await prisma.salesforceBackupManifest.findMany({ where: { datasetId: { in: [audienceDs.id, ...tracking.map((d) => d.id), ...(subsDs ? [subsDs.id] : []), ...mapping.exclusionDatasetIds] } }, orderBy: { version: "desc" }, distinct: ["datasetId"], select: { datasetId: true, sha256: true, createdAt: true } });
    const limitations: string[] = [];
    if (rec.audienceLabel === "CURRENT_STATE")
      limitations.push(`The audience is a ${audienceDs.kind === "AUDIENCE_UPLOAD" ? "user-supplied file" : "Data Extension backup"} extracted ${audienceDs.finishedAt?.toISOString().slice(0, 10) ?? "on an unknown date"}. No evidence establishes that it equals the audience at send time; Data Extensions are frequently overwritten by automations. Differences may reflect later changes to the DE.`);
    else limitations.push(`The audience is labelled a historical send-time snapshot on the basis of: "${evidence.claim}" (attested by ${evidence.attestedBy}). This claim was not independently verified by the system.`);
    if (evidence.extractedAfterSend) limitations.push("The audience was extracted AFTER the send date.");
    if (unavailableJobs.length) limitations.push(`Send tracking is not available in the archive for JobID(s) ${unavailableJobs.join(", ")} (not extracted, or not retrievable within the configured ${settings.retention.soapTracking.days}-day retention window — ${settings.retention.soapTracking.confirmed ? "confirmed" : "UNCONFIRMED"}).`);
    limitations.push("A SentEvent records that Salesforce processed a send to the subscriber. It does not establish inbox delivery, and its absence alone does not prove the subscriber was suppressed or excluded.");
    if (subsDs) limitations.push(`Subscriber statuses come from the subscriber list extracted ${subsDs.finishedAt?.toISOString().slice(0, 10)} — the status at send time may have differed.`);
    else limitations.push("No subscriber list is archived for this Business Unit, so subscriber status could not be used as evidence.");
    if (mapping.exclusionDatasetIds.length) limitations.push("Exclusion/suppression snapshots reflect their contents at extraction time, not necessarily at send time — membership is a possible explanation only.");
    limitations.push("Salesforce's Send-object counters (NumberExcluded, Duplicates, ExistingUnsubscribes, …) explain differences in aggregate only and cannot be attributed to individual recipients.");
    limitations.push(`Identity matching: field "${mapping.field}" as ${mapping.mode === "EMAIL" ? "email -> SubscriberKey via the archived subscriber list" : "SubscriberKey"}, ${mapping.caseInsensitive ? "case-insensitive" : "case-sensitive"}${mapping.trim ? ", trimmed" : ""}.`);
    limitations.push(`Event timestamps without an offset were interpreted as UTC${settings.sourceUtcOffset} (${settings.sourceUtcOffsetConfirmed ? "confirmed" : "assumed — confirm for this account"}); raw strings are preserved.`);
    if (sentRaw.length !== sent.length) limitations.push(`${sentRaw.length - sent.length} identical SentEvent row(s) returned twice by Salesforce were counted once (all rows are preserved in the archive).`);
    if (rec.isSimulated) limitations.push("SIMULATED DATA — produced by the development simulator, not by Salesforce.");

    const fullSummary = {
      ...summary,
      jobs: jobs.map((j) => ({ jobId: j.jobId, emailName: j.emailName, subject: j.subject, sendDate: (j.sentDate ?? j.sendDate)?.toISOString() ?? null, counters: j.counters })),
      missingSendObjects: rec.jobIds.filter((j) => !jobs.some((x) => x.jobId === j)),
      trackingAvailability,
      unavailableJobs,
      datasets: {
        audience: { id: audienceDs.id, label: audienceDs.label, extractedAt: audienceDs.finishedAt?.toISOString() ?? null, verification: audienceDs.verificationStatus },
        tracking: tracking.map((d) => ({ id: d.id, kind: d.kind, jobId: d.sourceKey, status: d.status, verification: d.verificationStatus, extractedAt: d.finishedAt?.toISOString() ?? null, records: d.recordsExtracted })),
        subscribers: subsDs ? { id: subsDs.id, extractedAt: subsDs.finishedAt?.toISOString() ?? null } : null,
        exclusions: mapping.exclusionDatasetIds,
      },
      manifestRefs: manifests.map((m) => ({ datasetId: m.datasetId, sha256: m.sha256 })),
    };
    await prisma.salesforceReconciliationJob.update({
      where: { id },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        summary: fullSummary as unknown as Prisma.InputJsonValue,
        limitations: limitations as Prisma.InputJsonValue,
        inputsSha256: stableHash({ mapping, jobIds: rec.jobIds, window, manifests: manifests.map((m) => m.sha256).sort() }),
      },
    });
  } catch (err) {
    await prisma.salesforceReconciliationJob.update({ where: { id }, data: { status: "FAILED", finishedAt: new Date(), errorMessage: (err as Error).message.slice(0, 1000) } });
    throw err;
  }
}
