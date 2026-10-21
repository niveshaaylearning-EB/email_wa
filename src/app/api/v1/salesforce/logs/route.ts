import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { listExtractionErrors, listExtractionLogs } from "@/lib/services/salesforce/queries";

const Q = z.object({
  level: z.enum(["info", "warn", "error"]).optional(),
  q: z.string().max(200).optional(),
  backupJobId: z.string().optional(),
  errors: z.enum(["1"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

/** Extraction logs (per dataset / job) or, with errors=1, structured extraction errors. */
export const GET = apiRoute({ permission: "archive:read", query: Q }, async ({ query }) => (query.errors ? listExtractionErrors() : listExtractionLogs({ ...query, pageSize: 100 })));
