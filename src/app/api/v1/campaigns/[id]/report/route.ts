import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api/handler";
import { exportCampaignReportCsv } from "@/lib/services/analytics";
import { audit } from "@/lib/audit";

export const GET = apiRoute<undefined, undefined, { id: string }>({ permission: "analytics:read", rateLimitPerMinute: 10 }, async ({ params, user }) => {
  const csv = await exportCampaignReportCsv(params.id);
  await audit({ actor: user, action: "campaign.report_exported", entityType: "campaign", entityId: params.id, campaignId: params.id });
  return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="campaign-${params.id}-report.csv"` } });
});
