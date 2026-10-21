import Link from "next/link";
import { KeyRoundIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { requestMeta } from "@/lib/auth/session";
import { getDataExtension, searchDatasetRows } from "@/lib/services/salesforce/queries";
import { datasetDrawerData } from "@/lib/services/salesforce/views";
import { archiveAudit } from "@/lib/services/salesforce/audit";
import { PageHeader, SectionTitle } from "@/components/app/page-header";
import { KpiCard } from "@/components/app/kpi-card";
import { EmptyState, Notice } from "@/components/app/empty-state";
import { Pill } from "@/components/app/status";
import { UrlPagination, UrlSearch } from "@/components/app/url-controls";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DatasetDrawer } from "@/components/salesforce/dataset-drawer";
import { ExportButton } from "@/components/salesforce/export-button";
import { DatasetStatusBadge, SimulatedBadge, VerificationBadge, fmt } from "@/components/salesforce/status";
import { formatIST } from "@/lib/time";
import { AttestForm } from "./attest-form";

export const metadata = { title: "Data Extension" };

export default async function DataExtensionPage({ params, searchParams }: PageProps<"/salesforce/data-extensions/[id]">) {
  const user = await requirePageUser("archive:read");
  const { id } = await params;
  const sp = await searchParams;
  const { de, datasets } = await getDataExtension(id);
  const selectedId = typeof sp.ds === "string" ? sp.ds : (de.latestRowsDatasetId ?? datasets.find((d) => d.status === "EXTRACTED")?.id ?? null);
  const selected = datasets.find((d) => d.id === selectedId) ?? null;
  const page = Math.max(1, Number(sp.page) || 1);
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const rows = selected && selected.status === "EXTRACTED" ? await searchDatasetRows(selected.id, { q, page, pageSize: 50 }) : null;
  const columns = de.fields.map((f) => f.name);
  const canExport = hasPermission(user.role, "archive:export");
  const canReconcile = hasPermission(user.role, "archive:reconcile");
  const retention = de.retention as Record<string, string | null>;
  if (q || page > 1) await archiveAudit({ actor: user, action: "archive.view.de_rows", entityType: "salesforce_data_extension", entityId: de.id, metadata: { datasetId: selected?.id, q: q ?? null, page }, ...(await requestMeta()) });

  return (
    <div className="animate-in-fade space-y-6">
      <PageHeader
        eyebrow={<Link href="/salesforce/data-extensions" className="hover:underline">Data Extensions</Link>}
        title={<span className="inline-flex flex-wrap items-center gap-2">{de.name}{de.isSimulated && <SimulatedBadge />}</span>}
        description={de.description ?? undefined}
        actions={canExport && selected?.status === "EXTRACTED" ? <ExportButton spec={{ type: "dataset_rows", datasetId: selected.id }} label="Download rows" variant="default" /> : undefined}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Archived rows (selected snapshot)" value={selected ? fmt.format(selected.recordsExtracted) : "—"} hint={selected?.finishedAt ? `extracted ${formatIST(selected.finishedAt)}` : "no snapshot"} />
        <KpiCard label="Independent source count" value={de.attestedCount !== null ? fmt.format(de.attestedCount) : "not available"} hint={de.attestedCount !== null ? `attested by ${de.attestedByEmail} · ${formatIST(de.attestedAt)}` : "Salesforce has no documented API row count — attest the UI count"} tone={de.attestedCount !== null ? (de.attestedCount === selected?.recordsExtracted ? "success" : "warning") : "default"} />
        <KpiCard label="Verification" value={selected ? <VerificationBadge status={selected.verificationStatus} /> : "—"} hint={selected?.verifiedAt ? `checked ${formatIST(selected.verifiedAt)}` : undefined} />
        <KpiCard label="Snapshots archived" value={fmt.format(datasets.filter((d) => d.status === "EXTRACTED").length)} hint={`${datasets.length} extraction attempt(s)`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Schema</CardTitle>
            <CardDescription className="text-xs">Field definitions as reported by Salesforce (DataExtensionField). Values are archived as the exact strings returned.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Field</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Length</TableHead>
                    <TableHead>Primary key</TableHead>
                    <TableHead>Nullable</TableHead>
                    <TableHead>Default</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {de.fields.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell className="tabular text-xs text-muted-foreground">{f.ordinal ?? "—"}</TableCell>
                      <TableCell className="font-mono text-[13px]">{f.name}</TableCell>
                      <TableCell>{f.fieldType ?? "—"}</TableCell>
                      <TableCell className="tabular">{f.maxLength || "—"}</TableCell>
                      <TableCell>{f.isPrimaryKey ? <span className="inline-flex items-center gap-1 text-primary"><KeyRoundIcon className="size-3.5" /> yes</span> : "—"}</TableCell>
                      <TableCell>{f.isRequired === null ? "?" : f.isRequired ? "no" : "yes"}</TableCell>
                      <TableCell className="font-mono text-xs">{f.defaultValue || "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Metadata</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-1.5 text-sm">
              {[
                ["CustomerKey", <span key="k" className="font-mono text-xs">{de.customerKey}</span>],
                ["ObjectID", <span key="o" className="font-mono text-[11px]">{de.objectId ?? "—"}</span>],
                ["MID", <span key="m" className="font-mono">{de.mid}</span>],
                ["Folder", de.folderPath ?? de.categoryId ?? "—"],
                ["Sendable", de.isSendable ? `yes (${de.sendableField ?? "?"})` : "no"],
                ["Created (source)", de.createdDate ?? "—"],
                ["Modified (source)", de.modifiedDate ?? "—"],
                ["Data retention", retention.DataRetentionPeriodLength ? `${retention.DataRetentionPeriodLength} ${retention.DataRetentionPeriod ?? ""}${retention.RowBasedRetention === "true" ? " (row-based)" : ""}` : "none configured"],
                ["First / last seen", `${formatIST(de.firstSeenAt, "dd MMM yyyy")} / ${formatIST(de.lastSeenAt, "dd MMM yyyy")}`],
              ].map(([k, v]) => (
                <div key={String(k)} className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="text-right">{v}</dd>
                </div>
              ))}
            </dl>
            {retention.DataRetentionPeriodLength && <Notice tone="warning" className="mt-3" title="Retention policy on this DE">Salesforce deletes rows from this DE automatically; earlier rows may already be gone. Archived snapshots keep what existed at extraction time.</Notice>}
            {canReconcile && (
              <div className="mt-4 border-t pt-4">
                <p className="mb-2 text-sm font-medium">Attest the Salesforce UI count</p>
                <AttestForm dataExtensionId={de.id} />
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <section>
        <SectionTitle
          title="Archived records"
          description={selected ? `Snapshot ${selected.id.slice(-8)} · extracted ${formatIST(selected.finishedAt)} — shows the DE as it was at that moment.` : undefined}
          actions={
            datasets.length > 1 ? (
              <div className="flex flex-wrap gap-1">
                {datasets.filter((d) => d.status === "EXTRACTED").slice(0, 6).map((d) => (
                  <Link key={d.id} href={`?ds=${d.id}`} className={`rounded-md border px-2 py-0.5 text-xs ${d.id === selected?.id ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}>
                    {formatIST(d.finishedAt, "dd MMM yyyy")}
                  </Link>
                ))}
              </div>
            ) : undefined
          }
        />
        {rows ? (
          <>
            <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <UrlSearch placeholder="Search any value or primary key" />
              {rows.capped && <p className="text-xs text-warning">Showing the first 5,000 matches — refine the search.</p>}
            </div>
            {rows.rows.length ? (
              <div className="overflow-hidden rounded-xl border bg-card">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead className="text-xs">Page · row</TableHead>
                        {columns.map((c) => (
                          <TableHead key={c} className="font-mono text-xs">{c}</TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.rows.map((r) => {
                        const v = r.values as Record<string, string | null>;
                        return (
                          <TableRow key={String(r.id)}>
                            <TableCell className="tabular text-xs text-muted-foreground">{r.pageNo}·{r.rowNo}</TableCell>
                            {columns.map((c) => (
                              <TableCell key={c} className="max-w-[220px] truncate font-mono text-xs" title={v[c] ?? ""}>
                                {v[c] === null || v[c] === undefined ? <span className="text-muted-foreground">null</span> : v[c] === "" ? <span className="text-muted-foreground">{'""'}</span> : v[c]}
                              </TableCell>
                            ))}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                <div className="border-t px-3">
                  <UrlPagination total={rows.total} page={page} pageSize={50} />
                </div>
              </div>
            ) : (
              <EmptyState compact title={q ? "No rows match" : "This snapshot has no rows"} />
            )}
          </>
        ) : (
          <EmptyState compact title="No row snapshot archived" description={datasets[0] ? `Latest attempt: ${datasets[0].status.replace(/_/g, " ").toLowerCase()}${datasets[0].errorMessage ? ` — ${datasets[0].errorMessage}` : ""}` : "Run a backup with “Data Extension rows” selected."} />
        )}
      </section>

      <section>
        <SectionTitle title="Extraction history" description="Every attempt is kept. Newer successful snapshots supersede older ones for search, but older snapshots remain archived and immutable." />
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Backup</TableHead>
                <TableHead>Extraction</TableHead>
                <TableHead>Verification</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead>Finished (IST)</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {datasets.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{d.backupJob ? <Link className="font-mono text-xs hover:underline" href={`/salesforce/backups/${d.backupJobId}`}>{d.backupJob.code}</Link> : "—"}{d.supersededById && <Pill tone="muted" className="ml-2">superseded</Pill>}</TableCell>
                  <TableCell><DatasetStatusBadge status={d.status} /></TableCell>
                  <TableCell><VerificationBadge status={d.verificationStatus} /></TableCell>
                  <TableCell className="tabular text-right">{fmt.format(d.recordsExtracted)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatIST(d.finishedAt)}</TableCell>
                  <TableCell className="text-right"><DatasetDrawer d={datasetDrawerData(d)} canExport={canExport} canReconcile={canReconcile} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
