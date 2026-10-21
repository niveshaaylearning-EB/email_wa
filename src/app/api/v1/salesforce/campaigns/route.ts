import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { listEmailJobs } from "@/lib/services/salesforce/queries";

const Q = z.object({
  q: z.string().max(200).optional(),
  mid: z.string().regex(/^\d{1,12}$/).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

/** Archived email send jobs: search by JobID, EmailID, subject or email name. */
export const GET = apiRoute({ permission: "archive:read", query: Q }, async ({ query }) =>
  listEmailJobs({ ...query, from: query.from ? new Date(query.from) : undefined, to: query.to ? new Date(query.to) : undefined }),
);
