import Link from "next/link";
import { CheckCheckIcon, ArrowRightIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, Notice } from "@/components/app/empty-state";
import { CampaignStatusBadge, CategoryChip, ChannelBadge, Pill } from "@/components/app/status";
import { Button } from "@/components/ui/button";
import { formatIST, relativeTime } from "@/lib/time";
import { hasPermission } from "@/lib/auth/permissions";

export const metadata = { title: "Approvals" };

export default async function ApprovalsPage() {
  const user = await requirePageUser("campaigns:read");
  const [pending, recent] = await Promise.all([
    prisma.campaign.findMany({
      where: { status: "PENDING_APPROVAL", deletedAt: null },
      orderBy: { submittedAt: "asc" },
      include: { categories: { include: { category: { select: { name: true, color: true } } } }, createdBy: { select: { name: true } }, submittedBy: { select: { name: true } } },
    }),
    prisma.campaign.findMany({
      where: { OR: [{ approvedAt: { not: null } }, { rejectedAt: { not: null } }], deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 15,
      include: { approvedBy: { select: { name: true } }, rejectedBy: { select: { name: true } } },
    }),
  ]);
  const isApprover = hasPermission(user.role, "campaigns:approve");
  return (
    <div className="animate-in-fade space-y-6">
      <PageHeader title="Approval queue" description="Maker-checker review. Approvers cannot approve campaigns they created or submitted. Approval freezes the exact audience and template versions." />
      {!isApprover && <Notice tone="info">You can view the queue; only users with the Approver role can approve or reject.</Notice>}
      {pending.length ? (
        <ul className="space-y-3">
          {pending.map((c) => {
            const own = c.createdById === user.id || c.submittedById === user.id;
            return (
              <li key={c.id} className="flex flex-col gap-3 rounded-xl border bg-card p-4 md:flex-row md:items-center">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{c.name}</p>
                    <ChannelBadge channel={c.channelMode} />
                    {own && <Pill tone="muted">Your submission</Pill>}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {c.categories.map((cc) => (
                      <CategoryChip key={cc.id} name={cc.category.name} color={cc.category.color} />
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Submitted by {c.submittedBy?.name ?? c.createdBy.name} {relativeTime(c.submittedAt)} · {c.purpose.replace(/_/g, " ").toLowerCase()}
                    {c.scheduledAt ? ` · scheduled ${formatIST(c.scheduledAt)}` : " · send on approval"}
                  </p>
                </div>
                <Button asChild variant={isApprover && !own ? "default" : "outline"}>
                  <Link href={`/campaigns/${c.id}`}>
                    {isApprover && !own ? "Review" : "View"} <ArrowRightIcon />
                  </Link>
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState icon={CheckCheckIcon} title="No campaigns awaiting approval" />
      )}
      <section>
        <h2 className="mb-2 text-sm font-semibold">Recent decisions</h2>
        <ul className="divide-y rounded-xl border bg-card">
          {recent.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
              <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">
                {c.name}
              </Link>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <CampaignStatusBadge status={c.status} />
                {c.rejectedAt && c.status === "REJECTED" ? `rejected by ${c.rejectedBy?.name} ${relativeTime(c.rejectedAt)}` : c.approvedAt ? `approved by ${c.approvedBy?.name} ${relativeTime(c.approvedAt)}` : ""}
              </span>
            </li>
          ))}
          {!recent.length && <li className="px-4 py-6 text-center text-sm text-muted-foreground">No decisions yet.</li>}
        </ul>
      </section>
    </div>
  );
}
