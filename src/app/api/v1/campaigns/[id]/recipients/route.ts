import { apiRoute } from "@/lib/api/handler";
import { z } from "zod";
import { listCampaignRecipients } from "@/lib/services/analytics";

const Q = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(10).max(200).default(50), status: z.string().optional(), channel: z.string().optional(), q: z.string().optional() });
export const GET = apiRoute<undefined, typeof Q, { id: string }>({ permission: "campaigns:read", query: Q }, async ({ params, query }) => listCampaignRecipients(params.id, query));
