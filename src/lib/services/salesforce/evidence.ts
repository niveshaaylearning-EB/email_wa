/**
 * SEBI Audit Center evidence: structured reports, PDF summaries and evidence packages.
 *
 * Every report separates: source records, extracted copies, derived calculations,
 * assumptions, missing evidence and retention limitations. Reports are for INTERNAL
 * compliance review — the system never certifies regulatory compliance.
 *
 * A package = report.json + recipient-level CSV + summary.pdf + package-manifest.json, each
 * stored write-once in the encrypted archive store with its SHA-256 recorded (append-only).
 */
import "server-only";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { badRequest, notFound } from "@/lib/errors";
import { stableStringify } from "@/lib/crypto";
import { getObject, putObject, sha256Hex } from "@/lib/salesforce/storage";
import { emailForJob } from "./content";
import { RECON_CLASS_LABELS, RECON_FLAG_LABELS, type ReconSummary } from "@/lib/domain/salesforce-reconcile";
import { buildExport } from "./exports";
import { parseSettings } from "./connections";
import { currentTrackingDatasets } from "./reconciliation";
import { archiveAudit, archiveCode, type ArchiveActor } from "./audit";

const DISCLAIMER =
  "Prepared from the Niveshaay Salesforce Marketing Cloud archive for INTERNAL compliance review. It is not a certification of regulatory compliance. Review the stated limitations before relying on, or submitting, any figure.";

const METHODOLOGY = [
  "Source data was read from Salesforce Marketing Cloud Engagement using only documented read operations (SOAP Retrieve, REST GET) with an Installed Package API integration. Nothing in Salesforce was modified.",
  "Each response page was stored unaltered (encrypted) with its SHA-256 hash; normalised copies were derived from those pages. Dataset and job manifests chain these hashes.",
  "Audience rows were matched to SentEvents for the selected JobID(s) on the stated identity field. Repeated identical event rows returned by Salesforce are preserved but counted once.",
  "Audience records without a SentEvent were classified by the strongest available evidence: a recipient-level NotSentEvent (verified), current subscriber status / exclusion snapshot / earlier unsubscribe (possible explanation only), or none (UNRESOLVED).",
];

// ─── Report builders ──────────────────────────────────────────────────

export async function reconciliationReport(id: string) {
  const rec = await prisma.salesforceReconciliationJob.findUnique({ where: { id } });
  if (!rec) throw notFound("Reconciliation");
  if (rec.status !== "COMPLETED") throw badRequest("The reconciliation has not completed.");
  const s = rec.summary as unknown as ReconSummary & {
    jobs: { jobId: string; emailName: string | null; subject: string | null; sendDate: string | null; counters: Record<string, string | null> }[];
    datasets: { audience: { id: string; label: string; extractedAt: string | null; verification: string }; tracking: { id: string; kind: string; jobId: string; status: string; verification: string; extractedAt: string | null; records: number }[]; subscribers: { id: string; extractedAt: string | null } | null };
    manifestRefs: { datasetId: string; sha256: string }[];
    unavailableJobs: string[];
    missingSendObjects: string[];
  };
  const bu = await prisma.salesforceBusinessUnit.findFirst({ where: { mid: rec.mid }, select: { name: true } });
  const evidence = rec.audienceEvidence as Record<string, unknown>;
  return {
    reportType: "SALESFORCE_AUDIENCE_SEND_RECONCILIATION",
    reportVersion: 1,
    disclaimer: DISCLAIMER,
    simulated: rec.isSimulated,
    reconciliation: { id: rec.id, code: rec.code, name: rec.name, createdBy: rec.createdByEmail, createdAt: rec.createdAt.toISOString(), completedAt: rec.finishedAt?.toISOString() ?? null, inputsSha256: rec.inputsSha256 },
    campaign: {
      businessUnit: { mid: rec.mid, name: bu?.name ?? null },
      jobIds: rec.jobIds,
      jobs: s.jobs.map((j) => ({ jobId: j.jobId, emailName: j.emailName, subject: j.subject, sendDate: j.sendDate })),
      sendDateFilter: { from: rec.sendDateFrom?.toISOString() ?? null, to: rec.sendDateTo?.toISOString() ?? null },
    },
    audience: {
      source: rec.audienceSource,
      label: rec.audienceLabel === "HISTORICAL_EVIDENCED" ? "Historical send-time snapshot (claimed with evidence)" : "Current-state copy — NOT established as the send-time audience",
      datasetId: s.datasets.audience.id,
      datasetLabel: s.datasets.audience.label,
      snapshotDate: (evidence.uploadSnapshotDate as string | null) ?? s.datasets.audience.extractedAt,
      evidence,
    },
    sourceRecords: {
      description: "Records as returned by Salesforce (aggregate counters are Salesforce's own figures).",
      salesforceSendCounters: s.jobs.map((j) => ({ jobId: j.jobId, counters: j.counters })),
      missingSendObjects: s.missingSendObjects,
    },
    extractedCopies: {
      description: "Archived datasets used, with their verification status and manifest hashes.",
      audience: s.datasets.audience,
      tracking: s.datasets.tracking,
      subscribers: s.datasets.subscribers,
      manifestRefs: s.manifestRefs,
    },
    derivedCalculations: {
      description: "Computed by the archive from the extracted copies.",
      audienceRowCount: s.audienceRows,
      uniqueSubscriberCount: s.uniqueAudienceIdentities,
      observedSendEvents: s.observedSentEvents,
      uniqueRecipientsWithObservedSendEvent: s.uniqueRecipientsWithSentEvent,
      observedNotSentEvents: s.observedNotSentEvents,
      observedBounceEvents: s.observedBounceEvents,
      observedUnsubscribeEvents: s.observedUnsubEvents,
      matchedSubscribers: s.matched,
      unmatchedAudienceSubscribers: s.audienceWithoutSentEvent,
      duplicateAudienceRows: s.duplicateAudienceRows,
      invalidIdentifiers: s.invalidIdentifiers,
      unresolvedDifferences: s.unresolved,
      retentionUnavailable: s.retentionUnavailable,
      trackingNotInAudience: s.trackingNotInAudience,
      classification: Object.entries(s.byClass).map(([k, v]) => ({ classification: k, label: RECON_CLASS_LABELS[k as keyof typeof RECON_CLASS_LABELS], count: v })),
      evidenceFlags: Object.entries(s.flagCounts).map(([k, v]) => ({ flag: k, label: RECON_FLAG_LABELS[k] ?? k, count: v })),
      bridge: s.bridge,
    },
    assumptions: [`Identity mapping: ${JSON.stringify(rec.identityMapping)}`, ...((rec.limitations as string[]).filter((l) => /interpreted as UTC|Identity matching/.test(l)))],
    missingEvidence: [
      ...(s.unresolved ? [`${s.unresolved} audience identities have no SentEvent and no recipient-level or circumstantial evidence explaining why (UNRESOLVED).`] : []),
      ...(s.missingSendObjects.length ? [`No Send object archived for JobID(s) ${s.missingSendObjects.join(", ")}.`] : []),
      ...(s.unavailableJobs.length ? [`Send tracking not available for JobID(s) ${s.unavailableJobs.join(", ")}.`] : []),
    ],
    limitations: rec.limitations as string[],
    methodology: METHODOLOGY,
    generatedAt: new Date().toISOString(),
  };
}

export async function campaignReport(mid: string, jobId: string) {
  const job = await prisma.salesforceEmailJob.findFirst({ where: { mid, jobId } });
  if (!job) throw notFound("Archived email job");
  const tracking = await currentTrackingDatasets(mid, [jobId], ["TRACKING_SENT", "TRACKING_OPEN", "TRACKING_CLICK", "TRACKING_BOUNCE", "TRACKING_UNSUB", "TRACKING_NOTSENT"]);
  const stats = await prisma.salesforceTrackingEvent.groupBy({ by: ["eventType"], where: { datasetId: { in: tracking.filter((d) => d.status === "EXTRACTED").map((d) => d.id) } }, _count: true });
  const distinctSubs = await prisma.$queryRaw<{ event_type: string; subs: bigint; distinct_events: bigint }[]>`
    SELECT event_type::text, COUNT(DISTINCT subscriber_key) AS subs, COUNT(DISTINCT fingerprint) AS distinct_events FROM salesforce_tracking_events
    WHERE dataset_id = ANY(${tracking.filter((d) => d.status === "EXTRACTED").map((d) => d.id)}::text[]) GROUP BY event_type`;
  const conn = await prisma.salesforceConnection.findUnique({ where: { id: job.connectionId } });
  const settings = parseSettings(conn?.settings);
  const manifests = await prisma.salesforceBackupManifest.findMany({ where: { datasetId: { in: [job.datasetId, ...tracking.map((d) => d.id)] } }, orderBy: { version: "desc" }, distinct: ["datasetId"], select: { datasetId: true, sha256: true } });
  const kinds = ["TRACKING_SENT", "TRACKING_OPEN", "TRACKING_CLICK", "TRACKING_BOUNCE", "TRACKING_UNSUB", "TRACKING_NOTSENT"];
  return {
    reportType: "SALESFORCE_CAMPAIGN_EVIDENCE",
    reportVersion: 1,
    disclaimer: DISCLAIMER,
    simulated: job.isSimulated,
    campaign: { mid, jobId, emailId: job.emailId, emailName: job.emailName, subject: job.subject, fromName: job.fromName, fromAddress: job.fromAddress, status: job.status, sendDate: job.sendDate?.toISOString() ?? null, sentDate: job.sentDate?.toISOString() ?? null },
    sourceRecords: { description: "Send object as returned by Salesforce (aggregate counters are Salesforce's figures).", counters: job.counters, raw: job.raw },
    extractedCopies: {
      description: "Recipient-level tracking datasets for this JobID.",
      datasets: kinds.map((k) => {
        const d = tracking.find((t) => t.kind === k);
        return d ? { kind: k, id: d.id, status: d.status, verification: d.verificationStatus, records: d.recordsExtracted, extractedAt: d.finishedAt?.toISOString() ?? null } : { kind: k, status: "NOT_ARCHIVED", verification: null, records: null, extractedAt: null };
      }),
      manifestRefs: manifests,
    },
    derivedCalculations: {
      description: "Counts computed from archived events (identical duplicate rows counted once).",
      byEventType: stats.map((s) => {
        const d = distinctSubs.find((x) => x.event_type === s.eventType);
        return { eventType: s.eventType, rows: s._count, distinctEvents: Number(d?.distinct_events ?? 0), distinctSubscribers: Number(d?.subs ?? 0) };
      }),
    },
    assumptions: [`Event timestamps without an offset interpreted as UTC${settings.sourceUtcOffset} (${settings.sourceUtcOffsetConfirmed ? "confirmed" : "assumed"}).`],
    missingEvidence: kinds.filter((k) => !tracking.some((t) => t.kind === k && t.status === "EXTRACTED")).map((k) => `${k.replace("TRACKING_", "")} events: ${tracking.find((t) => t.kind === k)?.status === "NOT_RETRIEVABLE" ? "NOT RETRIEVABLE FROM THIS SOURCE (retention)" : "not archived"}`),
    limitations: [
      "A SentEvent shows Salesforce processed a send; it does not prove inbox delivery.",
      "The target audience at send time is not part of the Send object; use a reconciliation with an evidenced audience snapshot to assess it.",
      `Tracking retention (SOAP): ${settings.retention.soapTracking.days ?? "unknown"} days — ${settings.retention.soapTracking.confirmed ? "confirmed" : "UNCONFIRMED"}.`,
      ...(job.isSimulated ? ["SIMULATED DATA — not produced by Salesforce."] : []),
    ],
    methodology: METHODOLOGY.slice(0, 2),
    generatedAt: new Date().toISOString(),
  };
}

// ─── PDF ──────────────────────────────────────────────────────────────

/** Standard PDF fonts encode WinAnsi only; anything else is transliterated and flagged. */
function pdfSafe(s: string, state: { lossy: boolean }): string {
  const map: Record<string, string> = { "−": "-", "→": "->", "≥": ">=", "≤": "<=", "₹": "Rs.", "✓": "v", "Σ": "sum" };
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code < 32 || (code >= 0x7f && code < 0xa0)) out += " ";
    else if (code < 256 ||"€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ".includes(ch)) out += ch;
    else {
      out += map[ch] ?? "?";
      if (!map[ch]) state.lossy = true;
    }
  }
  return out;
}

class PdfWriter {
  page!: PDFPage;
  y = 0;
  state = { lossy: false };
  constructor(
    private doc: PDFDocument,
    private font: PDFFont,
    private bold: PDFFont,
    private footer: string,
  ) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([595, 842]);
    this.y = 800;
    this.page.drawText(pdfSafe(this.footer, this.state), { x: 40, y: 24, size: 7, font: this.font, color: rgb(0.45, 0.45, 0.45) });
  }
  ensure(h: number) {
    if (this.y - h < 50) this.newPage();
  }
  text(s: string, opts: { size?: number; bold?: boolean; color?: [number, number, number]; indent?: number } = {}) {
    const size = opts.size ?? 9;
    const font = opts.bold ? this.bold : this.font;
    const maxW = 515 - (opts.indent ?? 0);
    const words = pdfSafe(s, this.state).split(/\s+/);
    let line = "";
    const lines: string[] = [];
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(t, size) > maxW && line) {
        lines.push(line);
        line = w;
      } else line = t;
    }
    if (line) lines.push(line);
    for (const l of lines) {
      this.ensure(size + 4);
      this.page.drawText(l, { x: 40 + (opts.indent ?? 0), y: this.y, size, font, color: opts.color ? rgb(...opts.color) : rgb(0.1, 0.1, 0.12) });
      this.y -= size + 4;
    }
  }
  heading(s: string) {
    this.y -= 6;
    this.ensure(30);
    this.text(s, { size: 11, bold: true });
    this.page.drawLine({ start: { x: 40, y: this.y + 2 }, end: { x: 555, y: this.y + 2 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.82) });
    this.y -= 4;
  }
  kv(rows: [string, string | number | null | undefined][]) {
    for (const [k, v] of rows) {
      this.ensure(14);
      this.page.drawText(pdfSafe(k, this.state), { x: 40, y: this.y, size: 9, font: this.font, color: rgb(0.4, 0.4, 0.45) });
      const val = pdfSafe(v === null || v === undefined ? "—" : typeof v === "number" ? v.toLocaleString("en-IN") : String(v), this.state);
      const w = this.font.widthOfTextAtSize(val, 9);
      if (w < 300) {
        this.page.drawText(val, { x: 555 - w, y: this.y, size: 9, font: this.bold });
        this.y -= 13;
      } else {
        this.y -= 13;
        this.text(val, { indent: 20 });
      }
    }
  }
  bullets(items: string[]) {
    for (const i of items) this.text(`•  ${i}`, { indent: 6 });
  }
}

async function renderPdf(title: string, subtitle: string, sections: (w: PdfWriter) => void, simulated: boolean): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer("Niveshaay Communication Center — Salesforce Archive");
  doc.setCreationDate(new Date());
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new PdfWriter(doc, font, bold, `${title} · generated ${new Date().toISOString()} · internal compliance review only`);
  if (simulated) w.text("SIMULATED DATA — NOT FROM SALESFORCE", { size: 12, bold: true, color: [0.75, 0.3, 0] });
  w.text(title, { size: 16, bold: true });
  w.text(subtitle, { size: 9, color: [0.4, 0.4, 0.45] });
  w.y -= 4;
  w.text(DISCLAIMER, { size: 8, color: [0.55, 0.25, 0.05] });
  sections(w);
  if (w.state.lossy) {
    w.heading("Character note");
    w.text("Some characters outside the PDF's standard character set were replaced with '?'. The JSON and CSV files in this package contain the exact values.");
  }
  return Buffer.from(await doc.save());
}

export async function reconciliationPdf(report: Awaited<ReturnType<typeof reconciliationReport>>): Promise<Buffer> {
  const d = report.derivedCalculations;
  return renderPdf(
    `Reconciliation ${report.reconciliation.code}: ${report.reconciliation.name}`,
    `Business Unit ${report.campaign.businessUnit.mid}${report.campaign.businessUnit.name ? ` (${report.campaign.businessUnit.name})` : ""} · JobID(s) ${report.campaign.jobIds.join(", ")} · prepared by ${report.reconciliation.createdBy}`,
    (w) => {
      w.heading("Campaign");
      for (const j of report.campaign.jobs) w.kv([[`JobID ${j.jobId}`, `${j.emailName ?? ""} · ${j.sendDate ? j.sendDate.replace("T", " ").slice(0, 16) + " UTC" : "send date unknown"}`]]);
      w.kv([["Subject", report.campaign.jobs[0]?.subject ?? null]]);
      w.heading("Audience");
      w.kv([
        ["Source", report.audience.source],
        ["Label", report.audience.label],
        ["Dataset", report.audience.datasetLabel],
        ["Snapshot / extraction date", report.audience.snapshotDate],
      ]);
      w.heading("Derived calculations");
      w.kv([
        ["Audience row count", d.audienceRowCount],
        ["Unique subscriber count", d.uniqueSubscriberCount],
        ["Observed send events", d.observedSendEvents],
        ["Unique recipients with observed send events", d.uniqueRecipientsWithObservedSendEvent],
        ["Observed not-sent events", d.observedNotSentEvents],
        ["Observed bounce events", d.observedBounceEvents],
        ["Observed unsubscribe events", d.observedUnsubscribeEvents],
        ["Matched subscribers", d.matchedSubscribers],
        ["Unmatched audience subscribers", d.unmatchedAudienceSubscribers],
        ["Duplicate audience rows", d.duplicateAudienceRows],
        ["Missing / invalid identifiers", d.invalidIdentifiers],
        ["Unresolved differences", d.unresolvedDifferences],
        ["Tracking not retrievable", d.retentionUnavailable],
        ["In tracking, not in audience", d.trackingNotInAudience],
      ]);
      w.heading("Bridge: audience rows to recipients with a SentEvent");
      w.kv(d.bridge.map((b) => [b.label, b.value]));
      w.heading("Salesforce Send counters (source records, aggregate only)");
      for (const j of report.sourceRecords.salesforceSendCounters) {
        w.text(`JobID ${j.jobId}`, { bold: true });
        w.kv(Object.entries(j.counters).map(([k, v]) => [k, v]));
      }
      w.heading("Evidence flags");
      w.kv(d.evidenceFlags.map((f) => [f.label, f.count]));
      w.heading("Missing evidence");
      w.bullets(report.missingEvidence.length ? report.missingEvidence : ["None identified."]);
      w.heading("Evidence limitations");
      w.bullets(report.limitations);
      w.heading("Extracted copies & manifests");
      w.kv([
        ["Audience dataset", `${report.extractedCopies.audience.id} · ${report.extractedCopies.audience.verification} · extracted ${report.extractedCopies.audience.extractedAt ?? "?"}`],
        ...report.extractedCopies.tracking.map((t) => [`${t.kind} job ${t.jobId}`, `${t.status} · ${t.verification} · ${t.records} rows · ${t.extractedAt ?? ""}`] as [string, string]),
      ]);
      w.text("Manifest SHA-256:", { bold: true });
      w.bullets(report.extractedCopies.manifestRefs.map((m) => `${m.datasetId}: ${m.sha256}`));
      w.heading("Methodology");
      w.bullets(report.methodology);
      w.kv([
        ["Inputs SHA-256", report.reconciliation.inputsSha256],
        ["Report generated", report.generatedAt],
      ]);
    },
    report.simulated,
  );
}

export async function campaignPdf(report: Awaited<ReturnType<typeof campaignReport>>): Promise<Buffer> {
  return renderPdf(
    `Campaign evidence: JobID ${report.campaign.jobId}`,
    `${report.campaign.emailName ?? ""} · Business Unit ${report.campaign.mid}`,
    (w) => {
      w.heading("Campaign (source record)");
      w.kv([
        ["Email name", report.campaign.emailName],
        ["Subject", report.campaign.subject],
        ["From", `${report.campaign.fromName ?? ""} <${report.campaign.fromAddress ?? ""}>`],
        ["Status", report.campaign.status],
        ["Send date (UTC)", report.campaign.sendDate],
        ["Sent date (UTC)", report.campaign.sentDate],
      ]);
      w.heading("Salesforce Send counters (aggregate)");
      w.kv(Object.entries(report.sourceRecords.counters as Record<string, string | null>).map(([k, v]) => [k, v]));
      w.heading("Archived recipient-level tracking");
      w.kv(report.extractedCopies.datasets.map((d) => [d.kind.replace("TRACKING_", ""), `${d.status}${d.verification ? ` · ${d.verification}` : ""}${d.records !== null ? ` · ${d.records} rows` : ""}`]));
      w.heading("Derived calculations");
      w.kv(report.derivedCalculations.byEventType.map((e) => [e.eventType, `${e.distinctEvents} events · ${e.distinctSubscribers} subscribers`]));
      w.heading("Missing evidence");
      w.bullets(report.missingEvidence.length ? report.missingEvidence : ["None identified."]);
      w.heading("Assumptions & limitations");
      w.bullets([...report.assumptions, ...report.limitations]);
      w.text("Manifest SHA-256:", { bold: true });
      w.bullets(report.extractedCopies.manifestRefs.map((m) => `${m.datasetId}: ${m.sha256}`));
    },
    report.simulated,
  );
}

// ─── Packages ─────────────────────────────────────────────────────────

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function generateEvidencePackage(input: { kind: "RECONCILIATION"; reconciliationId: string } | { kind: "CAMPAIGN"; mid: string; jobId: string }, actor: ArchiveActor) {
  const code = archiveCode("EVP");
  const files: { name: string; data: Buffer; contentType: string }[] = [];
  let title: string;
  let simulated: boolean;
  if (input.kind === "RECONCILIATION") {
    const report = await reconciliationReport(input.reconciliationId);
    title = `Reconciliation ${report.reconciliation.code} — ${report.reconciliation.name}`;
    simulated = report.simulated;
    files.push({ name: "report.json", data: Buffer.from(JSON.stringify(report, null, 2)), contentType: "application/json" });
    files.push({ name: "recipients.csv", data: await streamToBuffer((await buildExport({ type: "reconciliation", reconciliationId: input.reconciliationId, format: "csv", safe: true })).stream), contentType: "text/csv; charset=utf-8" });
    files.push({ name: "summary.pdf", data: await reconciliationPdf(report), contentType: "application/pdf" });
  } else {
    const report = await campaignReport(input.mid, input.jobId);
    title = `Campaign evidence — JobID ${input.jobId}${report.campaign.emailName ? ` (${report.campaign.emailName})` : ""}`;
    simulated = report.simulated;
    files.push({ name: "report.json", data: Buffer.from(JSON.stringify(report, null, 2)), contentType: "application/json" });
    // The archived email itself (original, unaltered) with a note on whether it changed after the send.
    const sendJob = await prisma.salesforceEmailJob.findFirst({ where: { mid: input.mid, jobId: input.jobId } });
    const content = sendJob ? await emailForJob(sendJob) : null;
    const key = content?.email?.htmlStorageKey ?? content?.email?.textStorageKey ?? content?.asset?.contentStorageKey ?? null;
    if (key) files.push({ name: content?.email?.htmlStorageKey || (!content?.email && content?.asset) ? "email-content.html" : "email-content.txt", data: await getObject(key), contentType: "text/plain; charset=utf-8" });
    (report as Record<string, unknown>).emailContent = content
      ? {
          source: content.email ? "SOAP Email object" : content.asset ? "Content Builder asset" : "not archived",
          emailId: sendJob?.emailId ?? null,
          modifiedInSalesforce: content.emailRecord?.modifiedDate ?? content.asset?.modifiedDate ?? null,
          modifiedAfterSend: content.modifiedAfterSend,
          sha256: content.email?.htmlSha256 ?? content.asset?.contentSha256 ?? null,
          note: "Template as archived. Personalisation placeholders are not rendered; Salesforce keeps no per-recipient copy of sent emails.",
        }
      : { source: "not archived" };
    files[0] = { name: "report.json", data: Buffer.from(JSON.stringify(report, null, 2)), contentType: "application/json" };
    files.push({ name: "recipient-events.csv", data: await streamToBuffer((await buildExport({ type: "tracking", format: "csv", safe: true, mid: input.mid, jobId: input.jobId })).stream), contentType: "text/csv; charset=utf-8" });
    files.push({ name: "summary.pdf", data: await campaignPdf(report), contentType: "application/pdf" });
  }
  const stored = [];
  for (const f of files) {
    const s = await putObject(`evidence/${code}/${f.name}`, f.data);
    stored.push({ name: f.name, sha256: s.sha256, bytes: s.bytes, storageKey: s.storageKey, contentType: f.contentType });
  }
  const manifest = { packageCode: code, title, kind: input.kind, params: input, generatedAt: new Date().toISOString(), generatedBy: actor.email, simulated, files: stored.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })) };
  const manifestCanonical = stableStringify(manifest);
  const ms = await putObject(`evidence/${code}/package-manifest.json`, manifestCanonical, { gzip: false });
  stored.push({ name: "package-manifest.json", sha256: ms.sha256, bytes: ms.bytes, storageKey: ms.storageKey, contentType: "application/json" });
  const pkg = await prisma.salesforceEvidencePackage.create({
    data: { code, kind: input.kind, title, params: input as Prisma.InputJsonValue, files: stored as unknown as Prisma.InputJsonValue, manifestSha256: sha256Hex(manifestCanonical), isSimulated: simulated, createdById: actor.id, createdByEmail: actor.email },
  });
  await archiveAudit({ actor, action: "archive.evidence.generated", entityType: "salesforce_evidence_package", entityId: pkg.id, metadata: { code, kind: input.kind, files: stored.map((f) => `${f.name}:${f.sha256.slice(0, 12)}`) } });
  return pkg;
}
