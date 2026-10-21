import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { cancelBackup, resumeBackup, retryFailedDatasets } from "@/lib/services/salesforce/backups";

/** cancel (between batches) · resume (interrupted job) · retry (failed datasets as new datasets). */
export const POST = apiRoute<undefined, undefined, { id: string; action: string }>({ permission: "archive:manage", rateLimitPerMinute: 20 }, async ({ params, user }) => {
  const action = z.enum(["cancel", "resume", "retry"]).parse(params.action);
  if (action === "cancel") {
    await cancelBackup(params.id, user);
    return { ok: true, message: "Cancellation requested — extraction stops after the current batch" };
  }
  if (action === "resume") {
    await resumeBackup(params.id, user);
    return { ok: true, message: "Resume requested" };
  }
  const retried = await retryFailedDatasets(params.id, user);
  return { retried, message: `${retried} dataset(s) re-queued as new extractions` };
});
