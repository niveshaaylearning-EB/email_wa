import { apiRoute } from "@/lib/api/handler";
import { previewCampaignAudience } from "@/lib/services/campaigns";

export const GET = apiRoute<undefined, undefined, { id: string }>({ permission: "campaigns:read", rateLimitPerMinute: 60 }, async ({ params }) => previewCampaignAudience(params.id));
