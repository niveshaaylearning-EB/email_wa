import { apiRoute } from "@/lib/api/handler";
import { ReviewDecisionSchema } from "@/lib/contracts";
import { setReviewDecisions } from "@/lib/services/campaigns";

export const POST = apiRoute<typeof ReviewDecisionSchema, undefined, { id: string }>(
  { permission: "campaigns:write", body: ReviewDecisionSchema },
  async ({ params, body, user }) => setReviewDecisions(params.id, body.decisions, user),
);
