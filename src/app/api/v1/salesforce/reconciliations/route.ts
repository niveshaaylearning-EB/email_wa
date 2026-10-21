import { apiRoute } from "@/lib/api/handler";
import { ReconciliationRequestSchema, createReconciliation } from "@/lib/services/salesforce/reconciliation";
import { listReconciliations } from "@/lib/services/salesforce/queries";

export const GET = apiRoute({ permission: "archive:read" }, async () => listReconciliations());

/** Start an audience ↔ send-tracking reconciliation (runs in the background). */
export const POST = apiRoute({ permission: "archive:reconcile", body: ReconciliationRequestSchema, rateLimitPerMinute: 10 }, async ({ body, user }) => {
  const rec = await createReconciliation(body, user);
  return { id: rec.id, code: rec.code };
});
