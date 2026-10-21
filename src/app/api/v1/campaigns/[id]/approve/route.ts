import { apiRoute } from "@/lib/api/handler";
import { approveCampaign } from "@/lib/services/campaigns";
import { ApprovalSchema } from "@/lib/contracts";

export const POST = apiRoute<typeof ApprovalSchema, undefined, { id: string }>(
  { permission: "campaigns:approve", body: ApprovalSchema, rateLimitPerMinute: 30 },
  async ({ params, body, user }) => approveCampaign(params.id, body, user),
);
