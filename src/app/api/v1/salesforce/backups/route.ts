import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { BackupRequestSchema, createBackupJob } from "@/lib/services/salesforce/backups";
import { listBackupJobs } from "@/lib/services/salesforce/queries";

const Q = z.object({ page: z.coerce.number().int().min(1).default(1) });

export const GET = apiRoute({ permission: "archive:read", query: Q }, async ({ query }) => listBackupJobs(query.page));

/** Queue a read-only backup. Extraction runs in the background worker. */
export const POST = apiRoute({ permission: "archive:manage", body: BackupRequestSchema, rateLimitPerMinute: 10 }, async ({ body, user }) => {
  const job = await createBackupJob(body, user);
  return { id: job.id, code: job.code };
});
