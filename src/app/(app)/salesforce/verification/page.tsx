import Link from "next/link";
import { BadgeCheckIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { verificationBoard, verificationCounts } from "@/lib/services/salesforce/queries";
import { datasetDrawerData } from "@/lib/services/salesforce/views";
import { PageHeader } from "@/components/app/page-header";
import { KpiCard } from "@/components/app/kpi-card";
import { EmptyState, Notice } from "@/components/app/empty-state";
import { UrlPagination } from "@/components/app/url-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DatasetDrawer } from "@/components/salesforce/dataset-drawer";
import { DATASET_KIND_LABELS, DatasetStatusBadge, SimulatedBadge, VerificationBadge, fmt } from "@/components/salesforce/status";
import { formatIST } from "@/lib/time";
import { cn } from "@/lib/utils";

export const metadata = { title: "Backup verification" };

const STATUSES = ["VERIFIED", "PARTIALLY_VERIFIED", "UNVERIFIED", "FAILED", "NOT_ACCESSIBLE", "NOT_RETRIEVABLE"] as const;
const CHECK_DOT: Record<string, string> = { pass: "bg-success", fail: "bg-destructive", warn: "bg-warning", info: "bg-info", na: "bg-muted-foreground/40" };

export default async function VerificationPage({ searchParams }: PageProps<"/salesforce/verification">) {
  const user = await requirePageUser("archive:read");
  const sp = await searchParams;
  const status = typeof sp.status === "string" && STATUSES.includes(sp.status as never) ? sp.status : undefined;
  const kind = typeof sp.kind === "string" ? sp.kind : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const [counts, board] = await Promise.all([verificationCounts(), verificationBoard({ status, kind }, page, 100)]);
  const rows = board.rows;
  const count = (s: string) => counts.byStatus[s] ?? 0;
  const kinds = counts.kinds;
  const canExport = hasPermission(user.role, "archive:export");
  const canReconcile = hasPermission(user.role, "archive:reconcile");
  const link = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const m = { status, kind, ...patch };
    for (const [k, v] of Object.entries(m)) if (v) p.set(k, v);
    return `/salesforce/verification${p.toString() ? `?${p}` : ""}`;
  };

  return (
    <div className="animate-in-fade space-y-5">
      <PageHeader title="Backup verification" description="Completeness and integrity of every current dataset: page sequence, terminal pagination, full intermediate pages, count agreement, SHA-256 re-hash of raw payloads, duplicates, field validation and independent source counts." />
      <Notice tone="info" title="How statuses are assigned">
        VERIFIED requires every integrity check to pass <b>and</b> an independent count to match (REST totals, Send-object aggregates for tracking, or an attested UI count for Data Extensions). Without an independent count the best possible status is PARTIALLY VERIFIED (limited). NOT RETRIEVABLE means outside a retention window — not zero records.
      </Notice>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {STATUSES.map((s) => (
          <Link key={s} href={link({ status: status === s ? undefined : s })} className={cn("rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring", status === s && "ring-2 ring-primary/40")}>
            <KpiCard label={s.replace(/_/g, " ").toLowerCase()} value={fmt.format(count(s))} />
          </Link>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        <Link href={link({ kind: undefined })} className={cn("rounded-md border px-2 py-0.5 text-xs", !kind ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}>All types</Link>
        {kinds.map((k) => (
          <Link key={k} href={link({ kind: k })} className={cn("rounded-md border px-2 py-0.5 text-xs", kind === k ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}>{DATASET_KIND_LABELS[k] ?? k}</Link>
        ))}
      </div>
      {rows.length ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Dataset</TableHead>
                  <TableHead>Backup</TableHead>
                  <TableHead>Extraction</TableHead>
                  <TableHead>Verification</TableHead>
                  <TableHead>Checks</TableHead>
                  <TableHead className="text-right">Records</TableHead>
                  <TableHead className="text-right">Source count</TableHead>
                  <TableHead>Verified (IST)</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="max-w-[320px]">
                      <p className="truncate font-medium" title={d.label}>{d.label}</p>
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">{DATASET_KIND_LABELS[d.kind] ?? d.kind} · MID {d.mid}{d.isSimulated && <SimulatedBadge />}</p>
                    </TableCell>
                    <TableCell>{d.backupJob ? <Link className="font-mono text-xs hover:underline" href={`/salesforce/backups/${d.backupJobId}`}>{d.backupJob.code}</Link> : <span className="text-xs text-muted-foreground">upload</span>}</TableCell>
                    <TableCell><DatasetStatusBadge status={d.status} /></TableCell>
                    <TableCell><VerificationBadge status={d.verificationStatus} /></TableCell>
                    <TableCell>
                      <span className="flex gap-1">
                        {d.checks.map((c) => (
                          <span key={c.key} title={`${c.label}: ${c.status} — ${c.detail}`} className={cn("size-2.5 rounded-full", CHECK_DOT[c.status])} />
                        ))}
                      </span>
                    </TableCell>
                    <TableCell className="tabular text-right">{fmt.format(d.recordsExtracted)}</TableCell>
                    <TableCell className="tabular text-right text-muted-foreground">{d.sourceCount !== null ? fmt.format(d.sourceCount) : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{d.verifiedAt ? formatIST(d.verifiedAt, "dd MMM, hh:mm a") : "—"}</TableCell>
                    <TableCell className="text-right"><DatasetDrawer d={datasetDrawerData(d)} canExport={canExport} canReconcile={canReconcile} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-3">
            <UrlPagination total={board.total} page={page} pageSize={100} />
          </div>
        </div>
      ) : (
        <EmptyState icon={BadgeCheckIcon} title="No datasets in this view" />
      )}
    </div>
  );
}
