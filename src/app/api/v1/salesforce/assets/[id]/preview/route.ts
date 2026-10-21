import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { prisma } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { getObject } from "@/lib/salesforce/storage";
import { renderArchivedHtml } from "@/lib/services/salesforce/content";

const Q = z.object({ mode: z.enum(["archived", "remote", "source"]).default("archived") });

/**
 * Sanitised preview of archived Content Builder content (for a sandboxed iframe), or the original
 * source as plain text. Images come from the archive by default; "remote" loads them from the
 * live CDN (they may be tracking pixels).
 */
export const GET = apiRoute<undefined, typeof Q, { id: string }>({ permission: "archive:read", query: Q }, async ({ params, query }) => {
  const asset = await prisma.salesforceAsset.findUnique({ where: { id: params.id } });
  if (!asset?.contentStorageKey) throw notFound("Archived content");
  return renderArchivedHtml(asset.connectionId, (await getObject(asset.contentStorageKey)).toString("utf8"), query.mode);
});
