import { apiRoute } from "@/lib/api/handler";
import { reverifyDataset } from "@/lib/services/salesforce/verification";
import { archiveAudit } from "@/lib/services/salesforce/audit";

/** Re-run every verification check (re-hashes raw pages) and write a new manifest revision. */
export const POST = apiRoute<undefined, undefined, { id: string }>({ permission: "archive:reconcile", rateLimitPerMinute: 20 }, async ({ params, user, meta }) => {
  const status = await reverifyDataset(params.id);
  await archiveAudit({ actor: user, action: "archive.dataset.reverified", entityType: "salesforce_dataset", entityId: params.id, metadata: { status }, ...meta });
  return { status, message: `Verification: ${status.replace(/_/g, " ").toLowerCase()} (new manifest revision written)` };
});
