import Link from "next/link";
import { ShieldCheckIcon, TriangleAlertIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { getBackupJob } from "@/lib/services/salesforce/queries";
import { datasetDrawerData } from "@/lib/services/salesforce/views";
import { PageHeader, SectionTitle } from "@/components/app/page-header";
import { KpiCard } from "@/components/app/kpi-card";
import { Notice } from "@/components/app/empty-state";
import { Pill } from "@/components/app/status";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionButton, LiveRefresh } from "@/components/salesforce/action-button";
import { ExportButton } from "@/components/salesforce/export-button";
import { DatasetDrawer } from "@/components/salesforce/dataset-drawer";
import { DATASET_KIND_LABELS, DatasetStatusBadge, JobStatusBadge, SimulatedBadge, VerificationBadge, fmt, formatBytes } from "@/components/salesforce/status";
import { formatIST } from "@/lib/time";

export const metadata = { title: "Backup job" };

export default async function BackupJobPage({ params }: PageProps<"/salesforce/backups/[id]">) {
  const user = await requirePageUser("archive:read");
  const { id } = await params;
  const { job, errors, manifests, logs } = await getBackupJob(id);
  const canManage = hasPermission(user.role, "archive:manage");
  const canExport = hasPermission(user.role, "archive:export");
  const canReconcile = hasPermission(user.role, "archive:reconcile");
  const running = ["QUEUED", "RUNNING", "CANCELLING"].includes(job.status);
  const finished = !running;
  const current = job.datasets.filter((d) => !d.supersededById || !job.datasets.some((x) => x.id === d.supersededById));
  const doneCount = current.filter((d) => !["PENDING", "RUNNING"].includes(d.status)).length;
  const records = current.reduce((a, d) => a + d.recordsExtracted, 0);
  const stage = (job.scope as { stage?: number }).stage ?? 1;
  const running1 = current.find((d) => d.status === "RUNNING");
  const failed = current.filter((d) => d.status === "FAILED" || d.status === "CANCELLED").length;
  const notes = job.verificationNotes as string[];

  return (
    <div className="animate-in-fade space-y-6">
      <PageHeader
        eyebrow={
          <Link href="/salesforce/backups" className="hover:underline">
            Backup Center
          </Link>
        }
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-mono">{job.code}</span>
            <JobStatusBadge status={job.status} />
            {finished && <VerificationBadge status={job.verificationStatus} />}
            {job.isSimulated && <SimulatedBadge />}
          </span>
        }
        description={`${job.connection.name} · MID ${job.mids.join(", ")} · ${job.mode.toLowerCase()} · requested by ${job.createdByEmail ?? "—"} · ${formatIST(job.createdAt)}`}
        actions={
          <>
            <LiveRefresh active={running} />
            {canManage && running && job.status !== "CANCELLING" && (
              <ActionButton path={`/api/v1/salesforce/backups/${job.id}/cancel`} label="Cancel" icon="ban" confirm={{ title: "Cancel this backup?", description: "Extraction stops after the current page batch. Completed datasets stay archived and sealed; unfinished ones are marked cancelled.", destructive: true }} success="Cancellation requested" />
            )}
            {canManage && running && <ActionButton path={`/api/v1/salesforce/backups/${job.id}/resume`} label="Resume" icon="play" success="Resume requested" />}
            {canManage && finished && failed > 0 && <ActionButton path={`/api/v1/salesforce/backups/${job.id}/retry`} label={`Retry ${failed} failed`} icon="retry" />}
            {finished && <ActionButton path={`/api/v1/salesforce/backups/${job.id}/manifest-chain`} label="Verify manifest chain" icon="link" />}
            {canExport && manifests[0] && <ExportButton spec={{ type: "manifest", manifestId: manifests[0].id }} label="Manifest" formats={false} />}
          </>
        }
      />

      {notes.length > 0 && (
        <Notice tone={job.verificationStatus === "VERIFIED" ? "success" : "warning"} icon={job.verificationStatus === "VERIFIED" ? ShieldCheckIcon : TriangleAlertIcon} title="Completeness notes">
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Notice>
      )}
      {finished && job.verificationStatus === "VERIFIED" && <Notice tone="success" icon={ShieldCheckIcon} title="Every requested dataset was extracted and independently verified." />}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Datasets" value={`${fmt.format(doneCount)} / ${fmt.format(current.length)}`} hint={running ? `Stage ${stage} of 3 — later stages add datasets as dependencies finish` : `${fmt.format(current.filter((d) => d.status === "EXTRACTED").length)} extracted`} />
        <KpiCard label="Records extracted" value={fmt.format(records)} hint={`${fmt.format(current.reduce((a, d) => a + d.pagesFetched, 0))} pages`} />
        <KpiCard label="API calls · retries" value={fmt.format(job.datasets.reduce((a, d) => a + d.apiCalls, 0))} hint={`${fmt.format(job.datasets.reduce((a, d) => a + d.retries, 0))} retries · ${fmt.format(errors.length)} logged errors`} tone={errors.length ? "warning" : "default"} />
        <KpiCard label="Raw payload stored" value={formatBytes(job.datasets.reduce((a, d) => a + Number(d.bytesStored), 0))} hint={`${manifests.length ? `job manifest ${manifests[0].sha256.slice(0, 12)}…` : "manifest written at completion"}`} />
      </div>

      {running && (
        <div className="rounded-xl border bg-card p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium">{running1 ? `Extracting: ${running1.label}` : "Planning next stage…"}</span>
            <span className="tabular text-xs text-muted-foreground">
              {running1 ? `${fmt.format(running1.pagesFetched)} pages · ${fmt.format(running1.recordsExtracted)} records${running1.sourceCount ? ` of ${fmt.format(running1.sourceCount)}` : ""}` : ""}
            </span>
          </div>
          {running1?.sourceCount ? <Progress value={Math.min(100, (running1.recordsExtracted / running1.sourceCount) * 100)} /> : <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full w-1/3 animate-[pulse_1.6s_ease-in-out_infinite] rounded-full bg-info/60" /></div>}
          <p className="mt-2 text-xs text-muted-foreground">{running1?.sourceCount ? "Total reported by Salesforce." : "Salesforce does not report a total for this object, so progress is shown as pages and records only."}</p>
        </div>
      )}

      <section>
        <SectionTitle title="Datasets" description="One row per extracted object. Open a row for every verification check, hashes and exports." />
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Dataset</TableHead>
                  <TableHead>MID</TableHead>
                  <TableHead>Extraction</TableHead>
                  <TableHead>Verification</TableHead>
                  <TableHead className="text-right">Pages</TableHead>
                  <TableHead className="text-right">Records</TableHead>
                  <TableHead className="text-right">Source count</TableHead>
                  <TableHead>Finished</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {job.datasets.map((d) => (
                  <TableRow key={d.id} className={d.supersededById ? "opacity-55" : undefined}>
                    <TableCell className="max-w-[340px]">
                      <p className="truncate text-sm font-medium" title={d.label}>{d.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {DATASET_KIND_LABELS[d.kind] ?? d.kind}
                        {d.attempt > 1 && ` · attempt ${d.attempt}`}
                        {d.supersededById && " · superseded"}
                      </p>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{d.mid}</TableCell>
                    <TableCell><DatasetStatusBadge status={d.status} /></TableCell>
                    <TableCell>{d.sealedAt ? <VerificationBadge status={d.verificationStatus} /> : <Pill tone="muted">pending</Pill>}</TableCell>
                    <TableCell className="tabular text-right">{fmt.format(d.pagesFetched)}</TableCell>
                    <TableCell className="tabular text-right">{fmt.format(d.recordsExtracted)}</TableCell>
                    <TableCell className="tabular text-right text-muted-foreground">{d.sourceCount !== null ? fmt.format(d.sourceCount) : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{d.finishedAt ? formatIST(d.finishedAt, "dd MMM, hh:mm a") : "—"}</TableCell>
                    <TableCell className="text-right">
                      <DatasetDrawer d={datasetDrawerData(d)} canExport={canExport} canReconcile={canReconcile} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section>
          <SectionTitle title="API errors" description="Every failed call, including ones later retried successfully." />
          {errors.length ? (
            <ul className="max-h-96 divide-y overflow-auto rounded-xl border bg-card text-sm">
              {errors.map((e) => (
                <li key={e.id} className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={e.retryable ? "warning" : "danger"}>{e.code}</Pill>
                    <span className="font-mono text-xs">{e.objectType}</span>
                    {e.pageNo && <span className="text-xs text-muted-foreground">page {e.pageNo}</span>}
                    {e.httpStatus && <span className="text-xs text-muted-foreground">HTTP {e.httpStatus}</span>}
                    <span className="ml-auto text-xs text-muted-foreground">{formatIST(e.createdAt, "dd MMM, hh:mm:ss a")}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{e.message}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">No API errors recorded.</p>
          )}
        </section>
        <section>
          <SectionTitle title="Extraction log" actions={<Link href={`/salesforce/logs?backupJobId=${job.id}`} className="text-xs text-primary hover:underline">Full log</Link>} />
          <ul className="max-h-96 divide-y overflow-auto rounded-xl border bg-card text-sm">
            {logs.map((l) => (
              <li key={String(l.id)} className="flex gap-3 px-3 py-2">
                <span className="tabular w-24 shrink-0 text-xs text-muted-foreground">{formatIST(l.createdAt, "hh:mm:ss a")}</span>
                <Pill tone={l.level === "error" ? "danger" : l.level === "warn" ? "warning" : "muted"}>{l.level}</Pill>
                <span className="min-w-0 text-xs">{l.message}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
