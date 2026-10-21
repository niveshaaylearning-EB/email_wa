import { apiRoute } from "@/lib/api/handler";
import { cancelCampaign } from "@/lib/services/campaigns";
import { CancelSchema } from "@/lib/contracts";

export const POST = apiRoute<typeof CancelSchema, undefined, { id: string }>(
  { permission: "campaigns:execute", body: CancelSchema, rateLimitPerMinute: 30 },
  async ({ params, body, user }) => cancelCampaign(params.id, body.reason, user),
);
