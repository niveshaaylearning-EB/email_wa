/**
 * CONTENT_FILES datasets: download the images / PDFs referenced by archived content from their
 * public (published) URLs, so archived emails still render after the Salesforce account closes.
 *
 * Each successfully downloaded file is one "page" of the dataset (content-addressed in the
 * archive store, SHA-256 recorded), so the standard verification checks apply. Files that cannot
 * be downloaded (404, timeout, too large) are recorded with their status and reported as gaps.
 */
import "server-only";
import type { Prisma, SalesforceBackupDataset } from "@prisma/client";
import { prisma } from "@/lib/db";
import { maskDeep } from "@/lib/mask";
import { isSfmcError } from "@/lib/salesforce/errors";
import type { SfmcClient } from "@/lib/salesforce/client";
import { putObject, sha256Hex } from "@/lib/salesforce/storage";
import { extractionLog } from "./audit";
import type { DatasetCheckpoint, DatasetParams } from "./types";

export const MARKETING_CLOUD_CDN = /(^|\.)(sfmc-content\.com|exacttarget\.com|marketingcloudapis\.com)$/i;

const EXT_BY_TYPE: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/svg+xml": "svg", "image/webp": "webp", "application/pdf": "pdf", "video/mp4": "mp4", "text/html": "html" };

function extFor(url: string, contentType: string | null) {
  const t = contentType?.split(";")[0].trim().toLowerCase();
  if (t && EXT_BY_TYPE[t]) return EXT_BY_TYPE[t];
  const m = /\.([a-z0-9]{2,5})(?:\?|#|$)/i.exec(new URL(url).pathname);
  return m ? m[1].toLowerCase() : "bin";
}

/** Plan the file list: asset publishedURLs + external images in archived HTML on allowed hosts. */
export async function planContentFiles(connectionId: string, mid: string): Promise<{ files: { url: string; assetId: string | null }[]; allowedHosts: string[] }> {
  const assets = await prisma.salesforceAsset.findMany({ where: { connectionId, mid }, select: { assetId: true, raw: true, references: true } });
  const emails = await prisma.salesforceEmail.findMany({ where: { connectionId, mid }, select: { references: true } });
  const published = new Map<string, string>();
  for (const a of assets) {
    const url = ((a.raw as { fileProperties?: { publishedURL?: string } }).fileProperties ?? {}).publishedURL;
    if (url && /^https?:\/\//i.test(url)) published.set(url.replace(/^http:/i, "https:"), a.assetId);
  }
  const hosts = new Set<string>();
  for (const u of published.keys()) hosts.add(new URL(u).hostname.toLowerCase());
  const urls = new Map<string, string | null>(published);
  for (const refs of [...assets.map((a) => a.references), ...emails.map((e) => e.references)]) {
    for (const r of (refs as { kind: string; url: string }[]) ?? []) {
      if (r.kind !== "image" || !/^https?:\/\//i.test(r.url)) continue;
      let u: URL;
      try {
        u = new URL(r.url.replace(/^http:/i, "https:"));
      } catch {
        continue;
      }
      const h = u.hostname.toLowerCase();
      if (hosts.has(h) || MARKETING_CLOUD_CDN.test(h)) {
        hosts.add(h);
        if (!urls.has(u.toString())) urls.set(u.toString(), null);
      }
    }
  }
  // Skip files already archived successfully (incremental).
  const done = new Set((await prisma.salesforceContentFile.findMany({ where: { connectionId, storageKey: { not: null } }, select: { url: true } })).map((f) => f.url));
  const files = [...urls].filter(([u]) => !done.has(u)).map(([url, assetId]) => ({ url, assetId }));
  return { files, allowedHosts: [...hosts] };
}

export async function runFilesSlice(d: SalesforceBackupDataset, client: SfmcClient, maxFiles: number): Promise<"continue" | "done"> {
  const params = d.params as unknown as DatasetParams;
  const files = params.files ?? [];
  const allowed = new Set(params.allowedHosts ?? []);
  let cur = d;
  for (let i = 0; i < maxFiles; i++) {
    if (cur.backupJobId) {
      const job = await prisma.salesforceBackupJob.findUnique({ where: { id: cur.backupJobId }, select: { cancelRequestedAt: true } });
      if (job?.cancelRequestedAt) return "done";
    }
    const cp = (cur.checkpoint ?? {}) as DatasetCheckpoint & { failedFiles?: number };
    const idx = cp.restPage ?? 0;
    if (idx >= files.length) {
      await prisma.salesforceBackupDataset.update({ where: { id: cur.id }, data: { status: "EXTRACTED", finishedAt: new Date() } });
      await extractionLog({ backupJobId: cur.backupJobId, datasetId: cur.id, level: "info", message: `Downloaded ${cur.recordsExtracted} of ${files.length} content files${cp.failedFiles ? ` (${cp.failedFiles} unavailable)` : ""}` });
      return "done";
    }
    const f = files[idx];
    const callsBefore = client.apiCalls;
    let status: number | null = null;
    let error: string | null = null;
    let body: Buffer | null = null;
    let contentType: string | null = null;
    try {
      const r = await client.fetchPublicFile(f.url, allowed);
      status = r.status;
      body = r.body;
      contentType = r.contentType;
      if (!body) error = `HTTP ${r.status}`;
    } catch (err) {
      error = isSfmcError(err) ? err.message : String(err);
    }
    if (body) {
      const sha = sha256Hex(body);
      const stored = await putObject(`files/${cur.connectionId}/${sha.slice(0, 2)}/${sha}.${extFor(f.url, contentType)}`, body, { gzip: !/^(image\/(png|jpe?g|gif|webp)|video|application\/pdf)/i.test(contentType ?? "") });
      cur = await prisma.$transaction(async (tx) => {
        await tx.salesforceBackupPage.create({ data: { datasetId: cur.id, attempt: cur.attempt, pageNo: cur.pagesFetched + 1, recordCount: 1, requestId: null, overallStatus: `HTTP ${status}`, storageKey: stored.storageKey, sha256: stored.sha256, byteSize: stored.bytes } });
        const data = { assetId: f.assetId ?? null, storageKey: stored.storageKey, sha256: stored.sha256, bytes: stored.bytes, contentType, httpStatus: status, error: null, datasetId: cur.id, fetchedAt: new Date() };
        await tx.salesforceContentFile.upsert({ where: { connectionId_url: { connectionId: cur.connectionId, url: f.url } }, create: { connectionId: cur.connectionId, url: f.url, ...data }, update: data });
        return tx.salesforceBackupDataset.update({
          where: { id: cur.id },
          data: { pagesFetched: { increment: 1 }, recordsExtracted: { increment: 1 }, bytesStored: { increment: stored.bytes }, apiCalls: { increment: client.apiCalls - callsBefore }, checkpoint: { ...cp, restPage: idx + 1 } as Prisma.InputJsonValue, lastProgressAt: new Date() },
        });
      });
    } else {
      await prisma.salesforceContentFile.upsert({
        where: { connectionId_url: { connectionId: cur.connectionId, url: f.url } },
        create: { connectionId: cur.connectionId, url: f.url, assetId: f.assetId ?? null, httpStatus: status, error, datasetId: cur.id },
        update: { httpStatus: status, error, datasetId: cur.id, fetchedAt: new Date() },
      });
      await prisma.salesforceExtractionError.create({ data: { connectionId: cur.connectionId, backupJobId: cur.backupJobId, datasetId: cur.id, mid: cur.mid, objectType: "content file", stage: "file", httpStatus: status, code: "file", message: String(maskDeep(`${error}: ${f.url}`)).slice(0, 2000), retryable: false } });
      cur = await prisma.salesforceBackupDataset.update({ where: { id: cur.id }, data: { apiCalls: { increment: client.apiCalls - callsBefore }, checkpoint: { ...cp, restPage: idx + 1, failedFiles: (cp.failedFiles ?? 0) + 1 } as Prisma.InputJsonValue, lastProgressAt: new Date() } });
    }
  }
  return "continue";
}
