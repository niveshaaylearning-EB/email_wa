import { apiRoute } from "@/lib/api/handler";
import { ExportSpecSchema, signDownload } from "@/lib/services/salesforce/exports";
import { archiveAudit } from "@/lib/services/salesforce/audit";

/** Issue a short-lived (5 min) download link bound to the requesting user. */
export const POST = apiRoute({ permission: "archive:export", body: ExportSpecSchema, rateLimitPerMinute: 30 }, async ({ body, user, meta }) => {
  const signed = signDownload(body, user.id);
  await archiveAudit({ actor: user, action: "archive.export.requested", entityType: "salesforce_export", metadata: { spec: body }, ...meta });
  return { url: `/api/v1/salesforce/download?token=${encodeURIComponent(signed.token)}`, expiresAt: signed.expiresAt };
});
