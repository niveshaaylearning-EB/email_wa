import { apiRoute } from "@/lib/api/handler";
import { z } from "zod";
import { CampaignDraftSchema } from "@/lib/contracts";
import { createCampaignDraft } from "@/lib/services/campaigns";
import { prisma } from "@/lib/db";
import type { CampaignStatus } from "@prisma/client";

export const GET = apiRoute(
  { permission: "campaigns:read", query: z.object({ status: z.string().optional() }) },
  async ({ query }) =>
    prisma.campaign.findMany({
      where: { deletedAt: null, ...(query.status ? { status: { in: query.status.split(",") as CampaignStatus[] } } : {}) },
      orderBy: { updatedAt: "desc" },
      take: 200,
      include: { categories: { include: { category: { select: { name: true, color: true } } } }, createdBy: { select: { name: true } } },
    }),
);
export const POST = apiRoute({ permission: "campaigns:write", body: CampaignDraftSchema }, async ({ body, user }) => createCampaignDraft(body, user));
