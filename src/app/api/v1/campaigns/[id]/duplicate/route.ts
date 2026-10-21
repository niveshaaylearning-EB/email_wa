import { apiRoute } from "@/lib/api/handler";
import { duplicateCampaign } from "@/lib/services/campaigns";

export const POST = apiRoute<undefined, undefined, { id: string }>({ permission: "campaigns:write", rateLimitPerMinute: 30 }, async ({ params, user }) => duplicateCampaign(params.id, user));
