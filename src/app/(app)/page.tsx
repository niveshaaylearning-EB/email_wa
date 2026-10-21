import Link from "next/link";
import {
  AlertTriangleIcon,
  CalendarClockIcon,
  CheckCheckIcon,
  CheckCircle2Icon,
  FlaskConicalIcon,
  MailIcon,
  MessageCircleIcon,
  PlusIcon,
  TagsIcon,
  UserCheckIcon,
  UsersIcon,
  XCircleIcon,
  RefreshCwIcon,
} from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { getCategoryPerformance, getOverview, getTrends } from "@/lib/services/analytics";
import { PageHeader } from "@/components/app/page-header";
import { KpiCard } from "@/components/app/kpi-card";
import { Notice } from "@/components/app/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ModeBadge, Pill } from "@/components/app/status";
import { OverviewCharts } from "./overview-charts";
import { relativeTime, formatIST, lastDays } from "@/lib/time";
import { hasPermission } from "@/lib/auth/permissions";

export const metadata = { title: "Overview" };

const nf = new Intl.NumberFormat("en-IN");

export default async function OverviewPage() {
  const user = await requirePageUser("analytics:read");
  const range30 = lastDays(30);
  const range12m = lastDays(365);
  const [o, daily, monthly, categories] = await Promise.all([getOverview(range30), getTrends(range30, "day"), getTrends(range12m, "month"), getCategoryPerformance(range30)]);
  const k = o.kpis;
  const healthTone = (s: string) => (s === "CONNECTED" ? "success" : s === "ERROR" ? "danger" : s === "CONFIGURED" ? "info" : "muted");

  return (
    <div className="animate-in-fade space-y-6">
      <PageHeader
        title={`Good ${greeting()}, ${user.name.split(" ")[0]}`}
        description="Communication activity across all categories for the last 30 days (IST)."
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

      {o.dataQuality.includesSimulated || o.dataQuality.mockClients > 0 ? (
        <Notice tone="warning" icon={FlaskConicalIcon} title="Development data — not real activity">
          {o.dataQuality.mockClients > 0 && <>{nf.format(o.dataQuality.mockClients)} mock CRM clients are loaded. </>}
          {o.dataQuality.simulatedMessages > 0 && (
            <>
              {nf.format(o.dataQuality.simulatedMessages)} of {nf.format(o.dataQuality.simulatedMessages + o.dataQuality.realMessages)} messages in this period were produced by MOCK adapters (marked “sim”).{" "}
            </>
          )}
          Connect Zoho CRM and providers in Integrations to see real data.
        </Notice>
      ) : null}

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="CRM clients" value={nf.format(k.totalClients)} icon={UsersIcon} href="/clients" hint={`${nf.format(k.clientsAssigned)} in categories`} />
        <KpiCard label="Categories" value={nf.format(k.totalCategories)} icon={TagsIcon} href="/categories" tone="brand" />
        <KpiCard label="Assigned clients" value={nf.format(k.clientsAssigned)} icon={UserCheckIcon} hint={k.totalClients ? `${Math.round((k.clientsAssigned / k.totalClients) * 100)}% of CRM` : undefined} />
        <KpiCard label="Pending approvals" value={nf.format(k.pendingApprovals)} icon={CheckCheckIcon} tone={k.pendingApprovals ? "warning" : "default"} href="/approvals" />
        <KpiCard label="Scheduled" value={nf.format(k.scheduled)} icon={CalendarClockIcon} href="/scheduled" />
        <KpiCard label="Failed messages" value={nf.format(k.failed)} icon={XCircleIcon} tone={k.failed ? "danger" : "default"} hint="Failed + bounced, 30 days" />
      </section>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Email campaigns sent" value={nf.format(k.emailCampaignsSent)} icon={MailIcon} />
        <KpiCard label="WhatsApp campaigns sent" value={nf.format(k.whatsappCampaignsSent)} icon={MessageCircleIcon} />
        <KpiCard label="WhatsApp delivered" value={nf.format(k.whatsappDelivered)} icon={CheckCircle2Icon} tone="success" hint={k.whatsappDeliveryRate !== null ? `${k.whatsappDeliveryRate}% of provider-accepted` : "Confirmed by delivery webhooks"} />
        <KpiCard label="Emails sent" value={nf.format(k.emailSent)} icon={MailIcon} hint="Per-recipient, from Zoho MA reports" />
        <KpiCard label="Email open rate" value={k.emailOpenRate !== null ? `${k.emailOpenRate}%` : null} unavailable={k.emailOpenRate === null ? "No reported sends yet" : undefined} />
        <KpiCard label="WhatsApp read rate" value={k.whatsappReadRate !== null ? `${k.whatsappReadRate}%` : null} unavailable={k.whatsappReadRate === null ? "No deliveries yet" : undefined} hint="Read receipts depend on recipient privacy settings" />
      </section>

      <OverviewCharts daily={daily} monthly={monthly} categories={categories} counts={o.counts} campaignStatus={o.campaignStatus} />

      <section className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Integration health</CardTitle>
            <CardDescription className="text-xs">Connection state and send mode for each provider.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {o.integrations.map((i) => (
                <li key={i.provider} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{i.label}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {i.lastError && i.status === "ERROR" ? `Last error ${relativeTime(i.lastErrorAt)}: ${i.lastError}` : i.lastSuccessAt ? `Last successful call ${relativeTime(i.lastSuccessAt)}` : "No successful API call yet"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Pill tone={healthTone(i.status)} dot>
                      {i.status.replace("_", " ").toLowerCase()}
                    </Pill>
                    <ModeBadge mode={i.mode} />
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Last CRM sync</CardTitle>
            <CardDescription className="text-xs">Zoho CRM remains the source of client contact data.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {o.lastCrmSync ? (
              <>
                <div className="flex items-center gap-2">
                  {o.lastCrmSync.status === "FAILED" ? <AlertTriangleIcon className="size-4 text-destructive" /> : <RefreshCwIcon className="size-4 text-success" />}
                  <span className="text-sm font-medium">{relativeTime(o.lastCrmSync.at)}</span>
                  <Pill tone={o.lastCrmSync.status === "SUCCEEDED" ? "success" : o.lastCrmSync.status === "FAILED" ? "danger" : "warning"}>{o.lastCrmSync.status.toLowerCase()}</Pill>
                </div>
                <p className="text-xs text-muted-foreground">{formatIST(o.lastCrmSync.at)} IST</p>
                <SyncStats stats={o.lastCrmSync.stats as Record<string, number>} />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">No synchronisation has run yet.</p>
            )}
            <Button asChild variant="outline" size="sm">
              <Link href="/integrations">Manage integrations</Link>
            </Button>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

function SyncStats({ stats }: { stats: Record<string, number> }) {
  const items: [string, string][] = [
    ["fetched", "Fetched"],
    ["created", "New"],
    ["updated", "Updated"],
    ["duplicatesFlagged", "Duplicates"],
  ];
  return (
    <dl className="grid grid-cols-4 gap-2 rounded-lg bg-muted/60 p-2.5 text-center">
      {items.map(([k, l]) => (
        <div key={k}>
          <dt className="text-[11px] text-muted-foreground">{l}</dt>
          <dd className="tabular text-sm font-semibold">{nf.format(stats?.[k] ?? 0)}</dd>
        </div>
      ))}
    </dl>
  );
}

function greeting() {
  const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false }).format(new Date()));
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}
