"use client";

/**
 * Chart primitives (Recharts). Spec: 2px lines, ≤24px bars with 4px rounded data-ends,
 * hairline recessive grid, one y-axis, legend for ≥2 series, hover tooltips, and a
 * table view toggle on every chart (accessibility + contrast relief for light hues).
 * Colors come from validated --viz-* tokens; text always uses text tokens.
 */
import { useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Table2Icon, LineChartIcon } from "lucide-react";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/app/empty-state";
import { cn } from "@/lib/utils";

const nf = new Intl.NumberFormat("en-IN");
const compact = (v: number) => (Math.abs(v) >= 1000 ? new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 }).format(v) : String(v));

export interface SeriesDef {
  key: string;
  label: string;
  color: string; // css var
}

function TooltipBox({ active, payload, label, series, labelFormat }: { active?: boolean; payload?: { dataKey: string; value: number }[]; label?: string; series: SeriesDef[]; labelFormat?: (l: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="min-w-36 rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1.5 font-medium text-foreground">{labelFormat ? labelFormat(String(label)) : label}</p>
      {series.map((s) => {
        const p = payload.find((x) => x.dataKey === s.key);
        return (
          <div key={s.key} className="flex items-center justify-between gap-4 py-0.5">
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <span className="size-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
            <span className="tabular font-medium text-foreground">{nf.format(Number(p?.value ?? 0))}</span>
          </div>
        );
      })}
    </div>
  );
}

function Legend({ series }: { series: SeriesDef[] }) {
  if (series.length < 2) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {series.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

function DataTableView({ rows, columns }: { rows: Record<string, unknown>[]; columns: { key: string; label: string; numeric?: boolean; format?: (v: unknown) => string }[] }) {
  return (
    <div className="max-h-72 overflow-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={cn("px-3 py-2 font-medium", c.numeric ? "text-right" : "text-left")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t">
              {columns.map((c) => (
                <td key={c.key} className={cn("px-3 py-1.5", c.numeric && "tabular text-right")}>
                  {c.format ? c.format(r[c.key]) : c.numeric ? nf.format(Number(r[c.key] ?? 0)) : String(r[c.key] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartCard({
  title,
  description,
  children,
  table,
  className,
  empty,
  footer,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  table?: React.ComponentProps<typeof DataTableView>;
  className?: string;
  empty?: boolean;
  footer?: React.ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        {description && <CardDescription className="text-xs">{description}</CardDescription>}
        {table && !empty && (
          <CardAction>
            <Button variant="ghost" size="icon-sm" onClick={() => setAsTable((v) => !v)} aria-label={asTable ? "Show chart" : "Show table"} title={asTable ? "Show chart" : "Show as table"}>
              {asTable ? <LineChartIcon /> : <Table2Icon />}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {empty ? <EmptyState compact title="No data in this period" description="Metrics appear once campaigns have been executed." /> : asTable && table ? <DataTableView {...table} /> : children}
        {footer}
      </CardContent>
    </Card>
  );
}

const axisProps = { tick: { fontSize: 11, fill: "var(--viz-axis)" }, tickLine: false, axisLine: false } as const;

export function TrendChart({ data, series, xKey, height = 240, xFormat }: { data: Record<string, unknown>[]; series: SeriesDef[]; xKey: string; height?: number; xFormat?: (v: string) => string }) {
  return (
    <div className="space-y-2">
      <Legend series={series} />
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <defs>
              {series.map((s) => (
                <linearGradient key={s.key} id={`fill-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.12} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" strokeWidth={1} />
            <XAxis dataKey={xKey} {...axisProps} tickFormatter={xFormat} minTickGap={24} />
            <YAxis {...axisProps} tickFormatter={compact} allowDecimals={false} width={44} />
            <Tooltip cursor={{ stroke: "var(--viz-axis)", strokeWidth: 1 }} content={<TooltipBox series={series} labelFormat={xFormat} />} />
            {series.map((s) => (
              <Area
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={2}
                fill={`url(#fill-${s.key})`}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--card)" }}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function HBarList({
  items,
  color = "var(--viz-1)",
  valueFormat = (v: number) => nf.format(v),
}: {
  items: { label: string; value: number; sub?: string; color?: string; swatch?: string }[];
  color?: string;
  valueFormat?: (v: number) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2.5">
      {items.map((i) => (
        <li key={i.label} className="group">
          <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
            <span className="flex min-w-0 items-center gap-1.5 truncate text-foreground">
              {i.swatch && <span className="size-2 shrink-0 rounded-full" style={{ background: i.swatch }} />}
              <span className="truncate">{i.label}</span>
            </span>
            <span className="tabular shrink-0 font-medium text-foreground">
              {valueFormat(i.value)}
              {i.sub && <span className="ml-1.5 font-normal text-muted-foreground">{i.sub}</span>}
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted">
            <div className="h-2 rounded-full transition-[width] duration-500" style={{ width: `${Math.max(i.value > 0 ? 1.5 : 0, (i.value / max) * 100)}%`, background: i.color ?? color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ColumnChart({ data, xKey, yKey, label, height = 220, colorFor }: { data: Record<string, unknown>[]; xKey: string; yKey: string; label: string; height?: number; colorFor?: (row: Record<string, unknown>) => string }) {
  const series = [{ key: yKey, label, color: "var(--viz-1)" }];
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }} barCategoryGap="28%">
          <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
          <XAxis dataKey={xKey} {...axisProps} interval={0} tickFormatter={(v: string) => (v.length > 14 ? `${v.slice(0, 13)}…` : v)} />
          <YAxis {...axisProps} tickFormatter={compact} allowDecimals={false} width={44} />
          <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.5 }} content={<TooltipBox series={series} />} />
          <Bar dataKey={yKey} maxBarSize={24} radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {data.map((row, i) => (
              <Cell key={i} fill={colorFor ? colorFor(row) : "var(--viz-1)"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Delivery funnel: each stage as a bar relative to the first, with % of previous stage. */
export function Funnel({ stages }: { stages: { label: string; value: number | null; note?: string; noPct?: boolean }[] }) {
  const first = stages.find((s) => s.value !== null)?.value ?? 0;
  return (
    <ol className="space-y-2.5">
      {stages.map((s, idx) => {
        const prev = stages.slice(0, idx).reverse().find((p) => p.value !== null)?.value ?? null;
        const pctPrev = s.value !== null && prev ? Math.round((s.value / prev) * 1000) / 10 : null;
        const width = s.value !== null && first ? Math.max(s.value > 0 ? 1.5 : 0, (s.value / first) * 100) : 0;
        return (
          <li key={s.label} title={s.note}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate text-muted-foreground">{s.label}</span>
              <span className="tabular shrink-0 font-medium text-foreground">
                {s.value === null ? <span className="font-normal text-muted-foreground">not reported</span> : s.value.toLocaleString("en-IN")}
                {pctPrev !== null && idx > 0 && !s.noPct && <span className="ml-1.5 font-normal text-muted-foreground">{pctPrev}%</span>}
              </span>
            </div>
            <div className="h-2.5 rounded-full bg-muted">
              <div className="h-2.5 rounded-full transition-[width] duration-500" style={{ width: `${width}%`, background: "var(--viz-1)" }} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
