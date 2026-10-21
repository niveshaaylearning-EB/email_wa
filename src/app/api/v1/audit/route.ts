import { apiRoute } from "@/lib/api/handler";
import { z } from "zod";
import { queryAudit } from "@/lib/services/users";

const Q = z.object({ q: z.string().optional(), entityType: z.string().optional(), campaignId: z.string().optional(), actorId: z.string().optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(10).max(200).default(50) });
export const GET = apiRoute({ permission: "audit:read", query: Q }, async ({ query }) => queryAudit(query));
