import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { buildExport, verifyDownload } from "@/lib/services/salesforce/exports";
import { archiveAudit } from "@/lib/services/salesforce/audit";

const Q = z.object({ token: z.string().min(10).max(8000) });

/** Streams an export. Requires a valid signed link issued to the same signed-in user. */
export const GET = apiRoute({ permission: "archive:export", query: Q, rateLimitPerMinute: 30 }, async ({ query, user, meta }) => {
  const spec = verifyDownload(query.token, user.id);
  const out = await buildExport(spec);
  await archiveAudit({ actor: user, action: `archive.export.${spec.type}`, entityType: "salesforce_export", metadata: { ...out.description, fileName: out.fileName }, ...meta });
  return new Response(out.stream, {
    headers: {
      "Content-Type": out.contentType,
      "Content-Disposition": `attachment; filename="${out.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
