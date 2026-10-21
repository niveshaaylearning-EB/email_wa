/**
 * Archived email content: resolving which email a send used, and rendering archived HTML with
 * images taken from the archive (not the live Salesforce CDN).
 */
import "server-only";
import { prisma } from "@/lib/db";
import { getObject } from "@/lib/salesforce/storage";
import { previewCsp, sanitizeArchivedHtml } from "@/lib/salesforce/sanitize";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

/** data: URIs for every archived copy of the given image URLs (bounded). */
export async function archivedImageMap(connectionId: string, urls: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(urls.map((u) => u.replace(/^http:/i, "https:").replace(/&amp;/g, "&")))];
  const files = wanted.length ? await prisma.salesforceContentFile.findMany({ where: { connectionId, url: { in: wanted }, storageKey: { not: null } } }) : [];
  const out = new Map<string, string>();
  let total = 0;
  for (const f of files) {
    if (!f.storageKey || !f.contentType?.startsWith("image/") || (f.bytes ?? 0) > MAX_IMAGE_BYTES || total + (f.bytes ?? 0) > MAX_TOTAL_BYTES) continue;
    const data = await getObject(f.storageKey);
    total += data.length;
    out.set(f.url, `data:${f.contentType.split(";")[0]};base64,${data.toString("base64")}`);
  }
  return out;
}

/** Render archived HTML for the sandboxed preview. mode: archived images (default) / remote / original source. */
export async function renderArchivedHtml(connectionId: string, html: string, mode: "archived" | "remote" | "source"): Promise<Response> {
  if (mode === "source") {
    return new Response(html, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "default-src 'none'; sandbox", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store, private" } });
  }
  const urls = [...html.matchAll(/<img\b[^>]*?\ssrc\s*=\s*["'](https?:[^"']+)["']/gi)].map((m) => m[1]);
  const archivedImages = mode === "archived" ? await archivedImageMap(connectionId, urls) : undefined;
  const allowRemote = mode === "remote";
  const { html: safe } = sanitizeArchivedHtml(html, { allowRemoteImages: allowRemote, archivedImages });
  return new Response(safe, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": previewCsp(allowRemote), "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store, private" },
  });
}

/**
 * The email a send job used, as archived: the SOAP Email object (preferred — it is what the send
 * referenced) or the Content Builder asset whose legacy id matches. Includes whether the archived
 * version was modified after the send (in which case it may not be exactly what was sent).
 */
export async function emailForJob(job: { connectionId: string; mid: string; emailId: string | null; sendDate: Date | null; sentDate: Date | null }) {
  if (!job.emailId) return null;
  const sentAt = job.sentDate ?? job.sendDate;
  const email = await prisma.salesforceEmail.findUnique({ where: { connectionId_mid_emailId: { connectionId: job.connectionId, mid: job.mid, emailId: job.emailId } } });
  const asset = await prisma.salesforceAsset.findFirst({
    where: { connectionId: job.connectionId, mid: job.mid, OR: [{ legacyId: job.emailId }, { assetId: job.emailId }] },
    select: { id: true, name: true, modifiedDate: true, contentStorageKey: true, contentSha256: true },
  });
  // Content Builder dates carry an explicit offset (e.g. "2026-08-20T05:08:01.84-06:00").
  const assetModified = asset?.modifiedDate ? new Date(asset.modifiedDate) : null;
  const modifiedAt = email?.modifiedAt ?? (assetModified && !Number.isNaN(assetModified.getTime()) ? assetModified : null);
  return {
    email: email && (email.htmlStorageKey || email.textStorageKey) ? email : null,
    emailRecord: email,
    asset: asset?.contentStorageKey ? asset : null,
    sentAt,
    modifiedAfterSend: modifiedAt && sentAt ? modifiedAt.getTime() > sentAt.getTime() : null,
  };
}
