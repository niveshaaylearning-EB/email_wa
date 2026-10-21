import { apiRoute } from "@/lib/api/handler";
import { pauseCampaign } from "@/lib/services/campaigns";

export const POST = apiRoute<undefined, undefined, { id: string }>({ permission: "campaigns:execute", rateLimitPerMinute: 30 }, async ({ params, user }) => pauseCampaign(params.id, user));
