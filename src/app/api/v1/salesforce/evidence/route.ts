import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { generateEvidencePackage } from "@/lib/services/salesforce/evidence";
import { listEvidencePackages } from "@/lib/services/salesforce/queries";

const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("RECONCILIATION"), reconciliationId: z.string().min(1) }),
  z.object({ kind: z.literal("CAMPAIGN"), mid: z.string().regex(/^\d{1,12}$/), jobId: z.string().regex(/^\d{1,15}$/) }),
]);

export const GET = apiRoute({ permission: "archive:read" }, async () => listEvidencePackages());

/** Build an immutable evidence package (report.json, CSV evidence, PDF summary, package manifest). */
export const POST = apiRoute({ permission: "archive:reconcile", body: Body, rateLimitPerMinute: 10 }, async ({ body, user }) => {
  const pkg = await generateEvidencePackage(body, user);
  return { id: pkg.id, code: pkg.code, message: `Evidence package ${pkg.code} created — download it from the SEBI Audit Center` };
});
