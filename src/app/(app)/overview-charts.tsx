"use client";

import { useState } from "react";
import { ChartCard, Funnel, HBarList, TrendChart } from "@/components/charts/charts";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type Trend = Record<string, number | string>;
interface Counts {
  total: number;
  submitted: number;
  accepted: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  opened: number;
  clicked: number;
}

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending approval",
  REJECTED: "Rejected",
  APPROVED: "Approved",
  SCHEDULED: "Scheduled",
  QUEUED: "Queued",
  RUNNING: "Sending",
  PAUSED: "Paused",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
};

const dayFmt = (v: string) => {
  const [, m, d] = v.split("-");
  return d ? `${Number(d)} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]}` : v;
};
const monthFmt = (v: string) => {
  const [y, m] = v.split("-");
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(m) - 1]} ${y.slice(2)}`;
};

export function OverviewCharts({
  daily,
  monthly,
  categories,
  counts,
  campaignStatus,
}: {
  daily: Trend[];
  monthly: Trend[];
  categories: { id: string; name: string; color: string; total: number; delivered: number; read: number; failed: number; opened: number }[];
  counts: { EMAIL: Counts; WHATSAPP: Counts };
  campaignStatus: Record<string, number>;
}) {
  const [grain, setGrain] = useState<"day" | "month">("day");
  const trend = grain === "day" ? daily : monthly;
  const empty = trend.every((t) => !Number(t.emailTotal) && !Number(t.whatsappTotal));
  const series = [
    { key: "emailTotal", label: "Email", color: "var(--viz-1)" },
    { key: "whatsappTotal", label: "WhatsApp", color: "var(--viz-2)" },
  ];
  const wa = counts.WHATSAPP;
  const em = counts.EMAIL;
  const statusItems = Object.entries(campaignStatus)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: STATUS_LABELS[k] ?? k, value: v, color: k === "FAILED" || k === "REJECTED" ? "var(--viz-critical)" : "var(--viz-1)" }));

  return (
    <section className="grid gap-4 lg:grid-cols-3">
      <ChartCard
        className="lg:col-span-2"
        title="Sending trend"
        description="Messages handed to providers per channel (excludes dry runs & cancellations)."
        empty={empty}
        table={{
          rows: trend,
          columns: [
            { key: "bucket", label: grain === "day" ? "Day" : "Month" },
            { key: "emailTotal", label: "Email", numeric: true },
            { key: "whatsappTotal", label: "WhatsApp", numeric: true },
            { key: "delivered", label: "Delivered", numeric: true },
            { key: "failed", label: "Failed", numeric: true },
          ],
        }}
      >
        <div className="flex justify-end">
          <ToggleGroup type="single" size="sm" variant="outline" value={grain} onValueChange={(v) => v && setGrain(v as "day" | "month")}>
            <ToggleGroupItem value="day">Daily</ToggleGroupItem>
            <ToggleGroupItem value="month">Monthly</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <TrendChart data={trend} series={series} xKey="bucket" xFormat={grain === "day" ? dayFmt : monthFmt} />
      </ChartCard>

      <ChartCard
        title="Delivery funnel"
        description="WhatsApp, last 30 days. Provider acceptance is not delivery."
        empty={wa.total === 0}
        table={{
          rows: [
            { stage: "Queued", v: wa.total },
            { stage: "Submitted", v: wa.submitted },
            { stage: "Provider accepted", v: wa.accepted },
            { stage: "Delivered", v: wa.delivered },
            { stage: "Read", v: wa.read },
            { stage: "Failed", v: wa.failed },
          ],
          columns: [
            { key: "stage", label: "Stage" },
            { key: "v", label: "Messages", numeric: true },
          ],
        }}
      >
        <Funnel
          stages={[
            { label: "Queued", value: wa.total },
            { label: "Submitted", value: wa.submitted },
            { label: "Provider accepted", value: wa.accepted },
            { label: "Delivered", value: wa.delivered, note: "Confirmed by DoubleTick delivery webhook" },
            { label: "Read", value: wa.read },
          ]}
        />
        <p className="text-xs text-muted-foreground">Failed: {wa.failed.toLocaleString("en-IN")}</p>
      </ChartCard>

      <ChartCard
        title="Channel performance"
        description="Last 30 days, per message."
        empty={wa.total + em.total === 0}
        table={{
          rows: [
            { metric: "Messages", email: em.total, whatsapp: wa.total },
            { metric: "Provider accepted", email: em.accepted, whatsapp: wa.accepted },
            { metric: "Sent / delivered", email: em.sent, whatsapp: wa.delivered },
            { metric: "Opened / read", email: em.opened, whatsapp: wa.read },
            { metric: "Failed", email: em.failed, whatsapp: wa.failed },
          ],
          columns: [
            { key: "metric", label: "Metric" },
            { key: "email", label: "Email", numeric: true },
            { key: "whatsapp", label: "WhatsApp", numeric: true },
          ],
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          {[
            { name: "Email", c: em, reach: em.sent, reachLabel: "sent (reported)", eng: em.opened, engLabel: "opened" },
            { name: "WhatsApp", c: wa, reach: wa.delivered, reachLabel: "delivered", eng: wa.read, engLabel: "read" },
          ].map((x, i) => (
            <div key={x.name} className="rounded-lg border p-3">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <span className="size-2 rounded-full" style={{ background: i === 0 ? "var(--viz-1)" : "var(--viz-2)" }} />
                {x.name}
              </p>
              <p className="tabular mt-2 text-xl font-semibold">{x.c.total.toLocaleString("en-IN")}</p>
              <p className="text-xs text-muted-foreground">messages</p>
              <dl className="mt-3 space-y-1 text-xs">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{x.reachLabel}</dt>
                  <dd className="tabular font-medium">{x.reach.toLocaleString("en-IN")}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{x.engLabel}</dt>
                  <dd className="tabular font-medium">{x.eng.toLocaleString("en-IN")}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">failed</dt>
                  <dd className="tabular font-medium">{x.c.failed.toLocaleString("en-IN")}</dd>
                </div>
              </dl>
            </div>
          ))}
        </div>
      </ChartCard>

      <ChartCard
        title="Category performance"
        description="Messages per category (assigned category of each message)."
        empty={categories.length === 0}
        table={{
          rows: categories,
          columns: [
            { key: "name", label: "Category" },
            { key: "total", label: "Messages", numeric: true },
            { key: "delivered", label: "Delivered", numeric: true },
            { key: "read", label: "Read", numeric: true },
            { key: "opened", label: "Opened", numeric: true },
            { key: "failed", label: "Failed", numeric: true },
          ],
        }}
      >
        <HBarList
          items={categories.slice(0, 8).map((c) => ({
            label: c.name,
            swatch: c.color,
            value: c.total,
            sub: c.total ? `${Math.round(((c.delivered + c.opened) / c.total) * 100)}% reached` : undefined,
          }))}
        />
      </ChartCard>

      <ChartCard
        title="Campaign status"
        description="All campaigns by current state."
        empty={statusItems.length === 0}
        table={{ rows: statusItems.map((s) => ({ status: s.label, count: s.value })), columns: [{ key: "status", label: "Status" }, { key: "count", label: "Campaigns", numeric: true }] }}
      >
        <HBarList items={statusItems} />
      </ChartCard>
    </section>
  );
}
