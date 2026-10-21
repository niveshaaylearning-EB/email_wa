import Link from "next/link";
import { PlusIcon, SendIcon } from "lucide-react";
import type { CampaignStatus, Prisma } from "@prisma/client";
import { requirePageUser } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CampaignStatusBadge, CategoryChip, ChannelBadge } from "@/components/app/status";
import { EmptyState } from "@/components/app/empty-state";
import { UrlSearch } from "@/components/app/url-controls";
import { hasPermission } from "@/lib/auth/permissions";
import { formatIST } from "@/lib/time";
import { StatusTabs } from "./status-tabs";

export const metadata = { title: "Campaign Studio" };

const GROUPS: Record<string, CampaignStatus[]> = {
  drafts: ["DRAFT", "REJECTED"],
  approval: ["PENDING_APPROVAL"],
  active: ["APPROVED", "SCHEDULED", "QUEUED", "RUNNING", "PAUSED"],
  done: ["COMPLETED", "CANCELLED", "FAILED"],
};

export default async function CampaignsPage({ searchParams }: PageProps<"/campaigns">) {
  const user = await requirePageUser("campaigns:read");
  const sp = await searchParams;
  const tab = typeof sp.tab === "string" && sp.tab in GROUPS ? sp.tab : "all";
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const where: Prisma.CampaignWhereInput = {
    deletedAt: null,
    ...(tab !== "all" ? { status: { in: GROUPS[tab] } } : {}),
    ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
  };
  const [campaigns, counts] = await Promise.all([
    prisma.campaign.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      take: 100,
      include: {
        categories: { include: { category: { select: { name: true, color: true } } }, orderBy: { priority: "asc" } },
        createdBy: { select: { name: true } },
        snapshot: { select: { summary: true } },
        _count: { select: { deliveries: true } },
      },
    }),
    prisma.campaign.groupBy({ by: ["status"], where: { deletedAt: null }, _count: true }),
  ]);
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count])) as Record<string, number>;
  const tabCounts = Object.fromEntries(Object.entries(GROUPS).map(([k, v]) => [k, v.reduce((n, s) => n + (byStatus[s] ?? 0), 0)]));

  return (
    <div className="animate-in-fade">
      <PageHeader
        title="Campaign Studio"
        description="Build category-targeted email and WhatsApp campaigns. Every campaign requires maker-checker approval before anything is queued."
        actions={
          hasPermission(user.role, "campaigns:write") && (
            <Button asChild>
              <Link href="/campaigns/new">
                <PlusIcon /> New campaign
              </Link>
            </Button>
          )
        }
      />
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <StatusTabs value={tab} counts={tabCounts} />
        <UrlSearch placeholder="Search campaigns" />
      </div>
      {campaigns.length ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Categories</TableHead>
                  <TableHead className="text-right">Messages</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Owner</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => {
                  const planned = (c.snapshot?.summary as { messageVolume?: number } | undefined)?.messageVolume;
                  const editable = ["DRAFT", "REJECTED"].includes(c.status);
                  return (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Link href={editable && hasPermission(user.role, "campaigns:write") ? `/campaigns/${c.id}/edit` : `/campaigns/${c.id}`} className="font-medium hover:underline">
                          {c.name}
                        </Link>
                        <p className="text-xs text-muted-foreground">{c.purpose.replace(/_/g, " ").toLowerCase()}{!c.isLive && c.approvedAt ? " · dry-run/mock" : ""}</p>
                      </TableCell>
                      <TableCell>
                        <CampaignStatusBadge status={c.status} />
                      </TableCell>
                      <TableCell>
                        <ChannelBadge channel={c.channelMode} />
                      </TableCell>
                      <TableCell>
                        <div className="flex max-w-xs flex-wrap gap-1">
                          {c.categories.map((cc) => (
                            <CategoryChip key={cc.id} name={cc.category.name} color={cc.category.color} />
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="tabular text-right">{planned !== undefined ? planned.toLocaleString("en-IN") : "—"}</TableCell>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{c.scheduledAt ? formatIST(c.scheduledAt) : c.completedAt ? `Done ${formatIST(c.completedAt, "dd MMM")}` : "Immediate"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.createdBy.name}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : (
        <EmptyState icon={SendIcon} title="No campaigns here" description="Create a campaign, select categories, choose authorised templates and submit it for approval." />
      )}
    </div>
  );
}
