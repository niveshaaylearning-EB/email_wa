import { apiRoute } from "@/lib/api/handler";
import { getReconciliation } from "@/lib/services/salesforce/queries";
import { reconciliationReport } from "@/lib/services/salesforce/evidence";
import { archiveAudit } from "@/lib/services/salesforce/audit";

/** Reconciliation status; once completed, the structured report. */
export const GET = apiRoute<undefined, undefined, { id: string }>({ permission: "archive:read" }, async ({ params, user, meta }) => {
  const { rec } = await getReconciliation(params.id);
  if (rec.status !== "COMPLETED") return { id: rec.id, code: rec.code, status: rec.status, errorMessage: rec.errorMessage };
  await archiveAudit({ actor: user, action: "archive.view.reconciliation", entityType: "salesforce_reconciliation", entityId: rec.id, metadata: { code: rec.code, via: "api" }, ...meta });
  return { id: rec.id, code: rec.code, status: rec.status, report: await reconciliationReport(rec.id) };
});
