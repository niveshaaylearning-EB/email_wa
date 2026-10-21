/**
 * Streaming exports + short-lived signed download links.
 *
 * - Data is streamed from PostgreSQL in keyset-paginated batches into the HTTP response, so
 *   large datasets never sit in browser or server memory.
 * - A download link is an HMAC-signed token (5 minutes) bound to the requesting user; the
 *   download route re-checks the session user and permission, then logs the export.
 * - JSONL preserves exact values. CSV is "safe" (formula-neutralised) by default.
 */
import "server-only";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { badRequest, forbidden } from "@/lib/errors";
import { getObject } from "@/lib/salesforce/storage";
import { csvLine } from "./csv";
import type { DatasetParams } from "./types";

export const ExportSpecSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("dataset_rows"), datasetId: z.string(), format: z.enum(["csv", "jsonl"]), safe: z.boolean().default(true) }),
  z.object({
    type: z.literal("tracking"),
    format: z.enum(["csv", "jsonl"]),
    safe: z.boolean().default(true),
    mid: z.string().optional(),
    jobId: z.string().optional(),
    subscriberKey: z.string().optional(),
    eventType: z.enum(["SENT", "OPEN", "CLICK", "BOUNCE", "UNSUB", "NOTSENT"]).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
  z.object({ type: z.literal("email_jobs"), format: z.enum(["csv", "jsonl"]), safe: z.boolean().default(true), mid: z.string().optional() }),
  z.object({ type: z.literal("reconciliation"), reconciliationId: z.string(), format: z.enum(["csv", "jsonl"]), safe: z.boolean().default(true), classification: z.string().optional() }),
  z.object({ type: z.literal("manifest"), manifestId: z.string() }),
  z.object({ type: z.literal("evidence_file"), packageId: z.string(), fileName: z.string() }),
  z.object({ type: z.literal("raw_page"), pageId: z.string() }),
]);
export type ExportSpec = z.infer<typeof ExportSpecSchema>;

// ─── Signed tokens ────────────────────────────────────────────────────

const TTL_MS = 5 * 60_000;
function signingKey() {
  const base = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!base) throw new Error("CREDENTIALS_ENCRYPTION_KEY is not set");
  return Buffer.from(hkdfSync("sha256", Buffer.from(base, "base64"), Buffer.from("ncc-download"), Buffer.from("ncc-archive-download-v1"), 32));
}

export function signDownload(spec: ExportSpec, userId: string): { token: string; expiresAt: string } {
  const exp = Date.now() + TTL_MS;
  const payload = Buffer.from(JSON.stringify({ s: spec, u: userId, e: exp })).toString("base64url");
  const sig = createHmac("sha256", signingKey()).update(payload).digest("base64url");
  return { token: `${payload}.${sig}`, expiresAt: new Date(exp).toISOString() };
}

export function verifyDownload(token: string, userId: string): ExportSpec {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) throw badRequest("Malformed download link.");
  const expected = createHmac("sha256", signingKey()).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw forbidden("Invalid download link.");
  const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { s: unknown; u: string; e: number };
  if (body.e < Date.now()) throw forbidden("This download link has expired. Request a new one.");
  if (body.u !== userId) throw forbidden("This download link was issued to another user.");
  return ExportSpecSchema.parse(body.s);
}

// ─── Streams ──────────────────────────────────────────────────────────

const enc = new TextEncoder();

function streamFrom(gen: () => AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const it = gen();
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await it.next();
      if (done) controller.close();
      else controller.enqueue(enc.encode(value));
    },
    async cancel() {
      await it.return(undefined);
    },
  });
}

async function* keyset<T extends { id: bigint }>(fetch: (cursor: bigint | undefined) => Promise<T[]>): AsyncGenerator<T> {
  let cursor: bigint | undefined;
  for (;;) {
    const batch = await fetch(cursor);
    if (!batch.length) return;
    for (const r of batch) yield r;
    cursor = batch[batch.length - 1].id;
  }
}

const jsonl = (o: unknown) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n";

export interface ExportResult {
  stream: ReadableStream<Uint8Array>;
  fileName: string;
  contentType: string;
  description: Record<string, unknown>;
}

export async function buildExport(spec: ExportSpec): Promise<ExportResult> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "");
  const ct = (f: "csv" | "jsonl") => (f === "csv" ? "text/csv; charset=utf-8" : "application/x-ndjson; charset=utf-8");
  switch (spec.type) {
    case "dataset_rows": {
      const ds = await prisma.salesforceBackupDataset.findUniqueOrThrow({ where: { id: spec.datasetId } });
      const params = ds.params as unknown as DatasetParams;
      if (ds.kind === "DE_ROWS" || ds.kind === "AUDIENCE_UPLOAD") {
        const fields = params.schema?.map((f) => f.name) ?? [];
        const rows = (c: bigint | undefined) => prisma.salesforceDataExtensionRow.findMany({ where: { datasetId: ds.id, ...(c ? { id: { gt: c } } : {}) }, orderBy: { id: "asc" }, take: 5000 });
        return {
          fileName: `${(ds.sourceKey ?? ds.id).replace(/[^A-Za-z0-9_-]/g, "_")}-${stamp}.${spec.format}`,
          contentType: ct(spec.format),
          description: { datasetId: ds.id, kind: ds.kind, records: ds.recordsExtracted, format: spec.format, safe: spec.safe },
          stream: streamFrom(async function* () {
            let header: string[] | null = fields.length ? fields : null;
            if (spec.format === "csv" && header) yield (spec.safe ? "﻿" : "") + csvLine(["_page", "_row", ...header], false);
            for await (const r of keyset(rows)) {
              const v = r.values as Record<string, string | null>;
              if (spec.format === "jsonl") {
                yield jsonl({ _datasetId: ds.id, _page: r.pageNo, _row: r.rowNo, _rowSha256: r.rowHash, ...v });
              } else {
                if (!header) {
                  header = Object.keys(v);
                  yield (spec.safe ? "﻿" : "") + csvLine(["_page", "_row", ...header], false);
                }
                yield csvLine([r.pageNo, r.rowNo, ...header.map((h) => v[h])], spec.safe);
              }
            }
          }),
        };
      }
      if (ds.kind.startsWith("TRACKING_")) return buildExport({ type: "tracking", format: spec.format, safe: spec.safe, jobId: ds.sourceKey ?? undefined, mid: ds.mid, eventType: ds.kind.replace("TRACKING_", "") as never });
      throw badRequest("This dataset type has no row export; download its raw pages or manifest instead.");
    }
    case "tracking": {
      const where = {
        datasetId: { in: (await prisma.salesforceBackupDataset.findMany({ where: { kind: { in: ["TRACKING_SENT", "TRACKING_OPEN", "TRACKING_CLICK", "TRACKING_BOUNCE", "TRACKING_UNSUB", "TRACKING_NOTSENT"] }, supersededById: null, status: { in: ["EXTRACTED"] }, ...(spec.mid ? { mid: spec.mid } : {}), ...(spec.jobId ? { sourceKey: spec.jobId } : {}) }, select: { id: true } })).map((d) => d.id) },
        ...(spec.subscriberKey ? { subscriberKey: spec.subscriberKey } : {}),
        ...(spec.eventType ? { eventType: spec.eventType } : {}),
        ...(spec.from || spec.to ? { eventDate: { ...(spec.from ? { gte: new Date(spec.from) } : {}), ...(spec.to ? { lte: new Date(spec.to) } : {}) } } : {}),
      };
      const cols = ["eventType", "jobId", "subscriberKey", "eventDateRaw", "eventDate", "batchId", "listId", "triggeredSendObjectId", "url", "bounceCategory", "bounceType", "smtpCode", "smtpReason", "sourceEventType", "mid", "datasetId", "pageNo", "rowNo", "fingerprint"] as const;
      return {
        fileName: `tracking${spec.jobId ? `-job${spec.jobId}` : ""}${spec.eventType ? `-${spec.eventType.toLowerCase()}` : ""}-${stamp}.${spec.format}`,
        contentType: ct(spec.format),
        description: { ...spec },
        stream: streamFrom(async function* () {
          if (spec.format === "csv") yield (spec.safe ? "﻿" : "") + csvLine([...cols], false);
          for await (const e of keyset((c) => prisma.salesforceTrackingEvent.findMany({ where: { ...where, ...(c ? { id: { gt: c } } : {}) }, orderBy: { id: "asc" }, take: 5000 }))) {
            if (spec.format === "jsonl") yield jsonl({ ...Object.fromEntries(cols.map((k) => [k, e[k]])), raw: e.raw });
            else yield csvLine(cols.map((k) => e[k]), spec.safe);
          }
        }),
      };
    }
    case "email_jobs": {
      const rows = await prisma.salesforceEmailJob.findMany({ where: spec.mid ? { mid: spec.mid } : {}, orderBy: { sendDate: "desc" } });
      const counterKeys = [...new Set(rows.flatMap((r) => Object.keys(r.counters as object)))].sort();
      const cols = ["mid", "jobId", "emailId", "emailName", "subject", "fromName", "fromAddress", "status", "sendDate", "sentDate"] as const;
      return {
        fileName: `email-jobs-${stamp}.${spec.format}`,
        contentType: ct(spec.format),
        description: { ...spec, rows: rows.length },
        stream: streamFrom(async function* () {
          if (spec.format === "csv") yield (spec.safe ? "﻿" : "") + csvLine([...cols, ...counterKeys, "datasetId"], false);
          for (const r of rows) {
            const c = r.counters as Record<string, string | null>;
            if (spec.format === "jsonl") yield jsonl({ ...Object.fromEntries(cols.map((k) => [k, r[k]])), counters: c, raw: r.raw, datasetId: r.datasetId });
            else yield csvLine([...cols.map((k) => r[k]), ...counterKeys.map((k) => c[k]), r.datasetId], spec.safe);
          }
        }),
      };
    }
    case "reconciliation": {
      const rec = await prisma.salesforceReconciliationJob.findUniqueOrThrow({ where: { id: spec.reconciliationId } });
      const where = { reconciliationId: rec.id, ...(spec.classification ? { classification: spec.classification as never } : {}) };
      return {
        fileName: `${rec.code}-recipients${spec.classification ? `-${spec.classification.toLowerCase()}` : ""}.${spec.format}`,
        contentType: ct(spec.format),
        description: { reconciliation: rec.code, ...spec },
        stream: streamFrom(async function* () {
          if (spec.format === "csv") yield (spec.safe ? "﻿" : "") + csvLine(["classification", "identity", "raw_identity", "flags", "sent_event_count", "first_sent_at_utc", "audience_rows", "evidence"], false);
          for await (const r of keyset((c) => prisma.salesforceReconciliationResult.findMany({ where: { ...where, ...(c ? { id: { gt: c } } : {}) }, orderBy: { id: "asc" }, take: 5000 }))) {
            if (spec.format === "jsonl") yield jsonl({ classification: r.classification, identity: r.identity, rawIdentity: r.rawIdentity, flags: r.flags, sentEventCount: r.sentEventCount, firstSentAt: r.firstSentAt, audienceRefs: r.audienceRefs, evidence: r.evidence });
            else
              yield csvLine(
                [r.classification, r.identity, r.rawIdentity, r.flags.join("|"), r.sentEventCount, r.firstSentAt, (r.audienceRefs as { page: number; row: number }[]).map((a) => `p${a.page}r${a.row}`).join(" "), JSON.stringify(r.evidence)],
                spec.safe,
              );
          }
        }),
      };
    }
    case "manifest": {
      const m = await prisma.salesforceBackupManifest.findUniqueOrThrow({ where: { id: spec.manifestId } });
      const data = m.storageKey ? await getObject(m.storageKey) : Buffer.from(JSON.stringify(m.manifest));
      return { fileName: `manifest-${m.scope.toLowerCase()}-${m.sha256.slice(0, 12)}.json`, contentType: "application/json", description: { manifestId: m.id, sha256: m.sha256 }, stream: streamFrom(async function* () { yield data.toString("utf8"); }) };
    }
    case "evidence_file": {
      const pkg = await prisma.salesforceEvidencePackage.findUniqueOrThrow({ where: { id: spec.packageId } });
      const f = (pkg.files as { name: string; storageKey: string; contentType: string; sha256: string }[]).find((x) => x.name === spec.fileName);
      if (!f) throw badRequest("File not in package.");
      const data = await getObject(f.storageKey);
      return {
        fileName: `${pkg.code}-${f.name}`,
        contentType: f.contentType,
        description: { package: pkg.code, file: f.name, sha256: f.sha256 },
        stream: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(data)); c.close(); } }),
      };
    }
    case "raw_page": {
      const p = await prisma.salesforceBackupPage.findUniqueOrThrow({ where: { id: spec.pageId } });
      const data = await getObject(p.storageKey);
      const ext = p.storageKey.endsWith(".json") ? "json" : "xml";
      return {
        fileName: `raw-${p.datasetId}-p${p.pageNo}.${ext}`,
        contentType: ext === "json" ? "application/json" : "application/xml",
        description: { pageId: p.id, sha256: p.sha256 },
        stream: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(data)); c.close(); } }),
      };
    }
  }
}
