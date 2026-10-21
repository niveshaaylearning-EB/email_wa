import { apiRoute } from "@/lib/api/handler";
import { CampaignDraftSchema } from "@/lib/contracts";
import { softDeleteDraft, updateCampaignDraft } from "@/lib/services/campaigns";
import { getCampaignAnalytics } from "@/lib/services/analytics";
import { notFound } from "@/lib/errors";

export const GET = apiRoute<undefined, undefined, { id: string }>({ permission: "campaigns:read" }, async ({ params }) => {
  const a = await getCampaignAnalytics(params.id);
  if (!a) throw notFound("Campaign");
  return a;
});
export const PUT = apiRoute<typeof CampaignDraftSchema, undefined, { id: string }>(
  { permission: "campaigns:write", body: CampaignDraftSchema },
  async ({ params, body, user }) => updateCampaignDraft(params.id, body, user),
);
export const DELETE = apiRoute<undefined, undefined, { id: string }>({ permission: "campaigns:write" }, async ({ params, user }) => softDeleteDraft(params.id, user));
