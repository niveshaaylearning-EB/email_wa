import { apiRoute } from "@/lib/api/handler";
import { rejectCampaign } from "@/lib/services/campaigns";
import { RejectionSchema } from "@/lib/contracts";

export const POST = apiRoute<typeof RejectionSchema, undefined, { id: string }>(
  { permission: "campaigns:approve", body: RejectionSchema, rateLimitPerMinute: 30 },
  async ({ params, body, user }) => rejectCampaign(params.id, body.reason, user),
);
