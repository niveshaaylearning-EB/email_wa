import Link from "next/link";
import { DatabaseBackupIcon, TriangleAlertIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { listConnections } from "@/lib/services/salesforce/connections";
import { listBackupJobs, listSchedules } from "@/lib/services/salesforce/queries";
import { BACKUP_DATA_TYPES } from "@/lib/salesforce/objects";
import { PageHeader, SectionTitle } from "@/components/app/page-header";
import { EmptyState, Notice } from "@/components/app/empty-state";
import { UrlPagination } from "@/components/app/url-controls";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pill } from "@/components/app/status";
import { JobStatusBadge, SimulatedBadge, VerificationBadge, fmt, formatBytes } from "@/components/salesforce/status";
import { LiveRefresh } from "@/components/salesforce/action-button";
import { formatIST, relativeTime } from "@/lib/time";
import { BackupForm } from "./backup-form";
import { ScheduleToggle } from "./schedule-toggle";

export const metadata = { title: "Backup Center" };

function duration(a: Date | null, b: Date | null) {
  if (!a) return "—";
  const ms = (b ?? new Date()).getTime() - a.getTime();
  const m = Math.floor(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m}m` : `${Math.max(1, Math.round(ms / 1000))}s`;
}

export default async function BackupCenterPage({ searchParams }: PageProps<"/salesforce/backups">) {
  const user = await requirePageUser("archive:read");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const canManage = hasPermission(user.role, "archive:manage");
  const [connections, jobs, schedules] = await Promise.all([listConnections(), listBackupJobs(page), listSchedules()]);
  const active = jobs.rows.some((j) => ["QUEUED", "RUNNING", "CANCELLING"].includes(j.status));

  return (
    <div className="animate-in-fade space-y-6">
      <PageHeader title="Backup Center" description="Orchestrate read-only extraction. Each dataset is paginated, checkpointed, hashed, verified and sealed. A backup is never called verified while requested data remains inaccessible or unverified." actions={<LiveRefresh active={active} />} />

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">New backup</CardTitle>
            <CardDescription className="text-xs">Choose business units and data. Tracking is extracted per JobID from the archived send jobs.</CardDescription>
          </CardHeader>
          <CardContent>
            <BackupForm connections={connections.map((c) => ({ id: c.id, name: c.name, kind: c.kind, status: c.status, businessUnits: c.businessUnits }))} options={BACKUP_DATA_TYPES.map((o) => ({ ...o }))} />
          </CardContent>
        </Card>
      )}

      <section>
        <SectionTitle title="Backup jobs" description="Progress is shown as counts of pages and records; percentages are shown only where Salesforce reports a total." />
        {jobs.rows.length ? (
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Backup ID</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Completeness</TableHead>
                    <TableHead>Started (IST)</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead className="text-right">Objects</TableHead>
                    <TableHead className="text-right">Records</TableHead>
                    <TableHead className="text-right">Errors</TableHead>
                    <TableHead className="text-right">Storage</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.rows.map((j) => {
                    const st = j.stats as { datasets?: number; records?: number; errors?: number; storageBytes?: number };
                    const done = ["COMPLETED", "COMPLETED_WITH_GAPS", "FAILED", "CANCELLED"].includes(j.status);
                    return (
                      <TableRow key={j.id}>
                        <TableCell>
                          <Link href={`/salesforce/backups/${j.id}`} className="font-mono text-[13px] font-medium hover:underline">
                            {j.code}
                          </Link>
                          {j.isSimulated && <SimulatedBadge className="ml-2" />}
                          <p className="text-xs text-muted-foreground">
                            {j.mode.toLowerCase()} · {(j.scope as { dataTypes: string[] }).dataTypes.length} data types{j.scheduleId ? " · scheduled" : ""}
                          </p>
                        </TableCell>
                        <TableCell className="text-xs">
                          {j.connection.name}
                          <p className="font-mono text-muted-foreground">MID {j.mids.join(", ")}</p>
                        </TableCell>
                        <TableCell>
                          <JobStatusBadge status={j.status} />
                        </TableCell>
                        <TableCell>{done ? <VerificationBadge status={j.verificationStatus} /> : <span className="text-xs text-muted-foreground">verifying as datasets finish</span>}</TableCell>
                        <TableCell className="tabular whitespace-nowrap text-xs text-muted-foreground">{formatIST(j.startedAt ?? j.createdAt)}</TableCell>
                        <TableCell className="tabular text-xs">{duration(j.startedAt, j.finishedAt)}</TableCell>
                        <TableCell className="tabular text-right">{st.datasets !== undefined ? fmt.format(st.datasets) : "—"}</TableCell>
                        <TableCell className="tabular text-right">{st.records !== undefined ? fmt.format(st.records) : "—"}</TableCell>
                        <TableCell className="tabular text-right">{st.errors ? <span className="text-destructive">{fmt.format(st.errors)}</span> : st.errors === 0 ? "0" : "—"}</TableCell>
                        <TableCell className="tabular text-right text-xs">{st.storageBytes !== undefined ? formatBytes(st.storageBytes) : "—"}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            <div className="border-t px-3">
              <UrlPagination total={jobs.total} page={page} pageSize={25} />
            </div>
          </div>
        ) : (
          <EmptyState icon={DatabaseBackupIcon} title="No backups yet" description="Run a first full backup while Salesforce is still accessible." />
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Scheduled backups</CardTitle>
            <CardDescription className="text-xs">Incremental runs while the Salesforce account remains active. The scheduler also resumes interrupted backups automatically.</CardDescription>
          </CardHeader>
          <CardContent>
            {schedules.length ? (
              <ul className="divide-y rounded-lg border">
                {schedules.map((s) => (
                  <li key={s.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{s.name}</p>
                      <p className="text-xs text-muted-foreground">
                        every {s.intervalHours}h · MID {s.mids.join(", ")} · next {s.enabled ? formatIST(s.nextRunAt) : "—"}
                        {s.lastRunAt ? ` · last ${relativeTime(s.lastRunAt)}` : ""}
                      </p>
                    </div>
                    {s.enabled ? <Pill tone="success">enabled</Pill> : <Pill tone="muted">paused</Pill>}
                    {canManage && <ScheduleToggle id={s.id} enabled={s.enabled} />}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No schedules. Use “Schedule recurring” above.</p>
            )}
          </CardContent>
        </Card>
        <Notice tone="warning" icon={TriangleAlertIcon} title="Data the read-only path cannot reach">
          <span className="block">• Data views (_Sent, _Open, _Click, _Bounce, _Job…) require a SQL Query Activity writing to a target Data Extension. That modifies the account, so it is never executed automatically.</span>
          <span className="block">• Data Extract / Tracking Extract activities deliver files to Enhanced FTP, which is unavailable.</span>
          <span className="block">• If you need these, an administrator must explicitly authorise a temporary query + DE; the resulting DE can then be archived here like any other. See docs/salesforce-archive.md → “Manual, authorised workflows”.</span>
        </Notice>
      </div>
    </div>
  );
}
