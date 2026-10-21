import { apiRoute } from "@/lib/api/handler";
import { getBackupJob } from "@/lib/services/salesforce/queries";

/** Backup status for live progress polling. Progress is reported as counts, never invented percentages. */
export const GET = apiRoute<undefined, undefined, { id: string }>({ permission: "archive:read" }, async ({ params }) => {
  const { job, errors } = await getBackupJob(params.id);
  return {
    id: job.id,
    code: job.code,
    status: job.status,
    verificationStatus: job.verificationStatus,
    stage: (job.scope as { stage?: number }).stage ?? 1,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    datasets: job.datasets.map((d) => ({ id: d.id, kind: d.kind, label: d.label, status: d.status, verificationStatus: d.verificationStatus, pagesFetched: d.pagesFetched, recordsExtracted: d.recordsExtracted, sourceCount: d.sourceCount, supersededById: d.supersededById, lastProgressAt: d.lastProgressAt })),
    errorCount: errors.length,
  };
});
