import Link from "next/link";
import { CalendarClockIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/empty-state";
import { CampaignStatusBadge, CategoryChip, ChannelBadge, Pill } from "@/components/app/status";
import { formatIST, relativeTime } from "@/lib/time";
import { formatDistanceToNowStrict } from "date-fns";

export const metadata = { title: "Scheduled campaigns" };

export default async function ScheduledPage() {
  await requirePageUser("campaigns:read");
  const rows = await prisma.campaign.findMany({
    where: { deletedAt: null, OR: [{ status: "SCHEDULED" }, { status: { in: ["DRAFT", "PENDING_APPROVAL", "PAUSED"] }, scheduledAt: { gt: new Date() } }] },
    orderBy: { scheduledAt: "asc" },
    include: { categories: { include: { category: { select: { name: true, color: true } } } }, snapshot: { select: { summary: true } }, approvedBy: { select: { name: true } } },
  });
  return (
    <div className="animate-in-fade">
      <PageHeader title="Scheduled campaigns" description="Upcoming sends in IST. Only approved campaigns are dispatched; drafts and pending ones with a future time are shown for visibility." />
      {rows.length ? (
        <ol className="relative space-y-3 border-l pl-6">
          {rows.map((c) => {
            const msgs = (c.snapshot?.summary as { messageVolume?: number } | undefined)?.messageVolume;
            return (
              <li key={c.id} className="relative">
                <span className="absolute -left-[31px] top-4 grid size-3.5 place-items-center rounded-full border-2 border-background bg-primary" />
                <Link href={`/campaigns/${c.id}`} className="block rounded-xl border bg-card p-4 transition-colors hover:border-foreground/15">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <p className="font-medium">{c.name}</p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ChannelBadge channel={c.channelMode} />
                        {c.categories.map((cc) => (
                          <CategoryChip key={cc.id} name={cc.category.name} color={cc.category.color} />
                        ))}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="tabular text-sm font-semibold">{formatIST(c.scheduledAt)}</p>
                      <p className="text-xs text-muted-foreground">{c.scheduledAt && c.scheduledAt > new Date() ? `in ${formatDistanceToNowStrict(c.scheduledAt)}` : relativeTime(c.scheduledAt)}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <CampaignStatusBadge status={c.status} />
                    {c.status !== "SCHEDULED" && <Pill tone="warning">Will not send until approved</Pill>}
                    {msgs !== undefined && <span>{msgs.toLocaleString("en-IN")} messages frozen</span>}
                    {c.approvedBy && <span>· approved by {c.approvedBy.name}</span>}
                    <span>· rate {c.rateLimitPerMinute}/min</span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyState icon={CalendarClockIcon} title="Nothing scheduled" description="Campaigns with a send time appear here after approval." />
      )}
    </div>
  );
}
