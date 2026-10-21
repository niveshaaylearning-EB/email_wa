import Link from "next/link";
import { FileArchiveIcon, GitCompareArrowsIcon, PlusIcon, ScaleIcon, SearchIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { listConnections } from "@/lib/services/salesforce/connections";
import { listArchiveAudit, listEvidencePackages, listReconciliations } from "@/lib/services/salesforce/queries";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState, Notice } from "@/components/app/empty-state";
import { UrlPagination } from "@/components/app/url-controls";
import { Pill } from "@/components/app/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExportButton } from "@/components/salesforce/export-button";
import { SimulatedBadge, VerificationBadge, fmt, formatBytes } from "@/components/salesforce/status";
import { formatIST } from "@/lib/time";
import { UploadForm } from "./upload-form";

export const metadata = { title: "SEBI Audit Center" };

export default async function AuditCenterPage({ searchParams }: PageProps<"/salesforce/audit">) {
  const user = await requirePageUser("archive:read");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const canReconcile = hasPermission(user.role, "archive:reconcile");
  const canExport = hasPermission(user.role, "archive:export");
  const canAudit = hasPermission(user.role, "audit:read");
  const [recons, packages, access, uploads, connections] = await Promise.all([
    listReconciliations(),
    listEvidencePackages(),
    canAudit ? listArchiveAudit({ q: typeof sp.q === "string" ? sp.q : undefined, page, pageSize: 50 }) : null,
    prisma.salesforceBackupDataset.findMany({ where: { kind: "AUDIENCE_UPLOAD" }, orderBy: { createdAt: "desc" }, take: 50 }),
    listConnections(),
  ]);

  return (
    <div className="animate-in-fade space-y-5">
      <PageHeader
        eyebrow={<span className="inline-flex items-center gap-1.5"><ScaleIcon className="size-3.5" /> Compliance workspace</span>}
        title="SEBI Audit Center"
        description="Search historical communication evidence, reconcile audiences against send tracking, and produce evidence packages for internal compliance review."
        actions={canReconcile ? <Button asChild size="sm"><Link href="/salesforce/audit/reconciliations/new"><GitCompareArrowsIcon /> New reconciliation</Link></Button> : undefined}
      />
      <Notice tone="warning" title="Reports support review — they do not certify compliance">
        Every report separates source records, extracted copies, derived calculations, assumptions, missing evidence and retention limitations. Review them before any submission. All views and exports of archived client data are recorded below.
      </Notice>

      <div className="grid gap-3 md:grid-cols-3">
        <form action="/salesforce/tracking" method="get" className="rounded-xl border bg-card p-4">
          <p className="mb-2 text-sm font-medium">Client / subscriber</p>
          <div className="flex gap-2"><Input name="subscriberKey" placeholder="SubscriberKey" className="h-9" /><Button size="sm" type="submit" variant="outline"><SearchIcon /></Button></div>
          <p className="mt-1.5 text-xs text-muted-foreground">Full communication timeline with explicit unknown states.</p>
        </form>
        <form action="/salesforce/campaigns" method="get" className="rounded-xl border bg-card p-4">
          <p className="mb-2 text-sm font-medium">Campaign or JobID</p>
          <div className="flex gap-2"><Input name="q" placeholder="JobID, subject, email name" className="h-9" /><Button size="sm" type="submit" variant="outline"><SearchIcon /></Button></div>
          <p className="mt-1.5 text-xs text-muted-foreground">Send counters, tracking coverage and evidence packages.</p>
        </form>
        <form action="/salesforce/campaigns" method="get" className="rounded-xl border bg-card p-4">
          <p className="mb-2 text-sm font-medium">Date range</p>
          <div className="flex gap-2"><Input type="date" name="from" className="h-9" /><Input type="date" name="to" className="h-9" /><Button size="sm" type="submit" variant="outline"><SearchIcon /></Button></div>
          <p className="mt-1.5 text-xs text-muted-foreground">Sends within a period (IST).</p>
        </form>
      </div>

      <Tabs defaultValue={typeof sp.tab === "string" ? sp.tab : "reconciliations"}>
        <TabsList>
          <TabsTrigger value="reconciliations">Reconciliations ({recons.length})</TabsTrigger>
          <TabsTrigger value="packages">Evidence packages ({packages.length})</TabsTrigger>
          <TabsTrigger value="uploads">Audience snapshots ({uploads.length})</TabsTrigger>
          {canAudit && <TabsTrigger value="access">Access log</TabsTrigger>}
        </TabsList>

        <TabsContent value="reconciliations" className="mt-4">
          {recons.length ? (
            <div className="overflow-hidden rounded-xl border bg-card">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Reconciliation</TableHead>
                    <TableHead>JobID(s)</TableHead>
                    <TableHead>Audience</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Audience rows</TableHead>
                    <TableHead className="text-right">Matched</TableHead>
                    <TableHead className="text-right">Unresolved</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recons.map((r) => {
                    const s = r.summary as { audienceRows?: number; matched?: number; unresolved?: number };
                    return (
                      <TableRow key={r.id}>
                        <TableCell>
                          <Link href={`/salesforce/audit/reconciliations/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
                          <p className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">{r.code}{r.isSimulated && <SimulatedBadge />}</p>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{r.jobIds.join(", ")}</TableCell>
                        <TableCell>{r.audienceLabel === "HISTORICAL_EVIDENCED" ? <Pill tone="info">historical (evidenced)</Pill> : <Pill tone="muted">current-state copy</Pill>}</TableCell>
                        <TableCell><Pill tone={r.status === "COMPLETED" ? "success" : r.status === "FAILED" ? "danger" : "info"} dot>{r.status.toLowerCase()}</Pill></TableCell>
                        <TableCell className="tabular text-right">{s.audienceRows !== undefined ? fmt.format(s.audienceRows) : "—"}</TableCell>
                        <TableCell className="tabular text-right">{s.matched !== undefined ? fmt.format(s.matched) : "—"}</TableCell>
                        <TableCell className="tabular text-right">{s.unresolved !== undefined ? <span className={s.unresolved ? "text-warning" : ""}>{fmt.format(s.unresolved)}</span> : "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{formatIST(r.createdAt)}<p>{r.createdByEmail}</p></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <EmptyState icon={GitCompareArrowsIcon} title="No reconciliations yet" description="Compare a Data Extension backup (or an uploaded audience file) against recipient-level send tracking for one or more JobIDs." action={canReconcile ? <Button asChild size="sm"><Link href="/salesforce/audit/reconciliations/new"><PlusIcon /> New reconciliation</Link></Button> : undefined} />
          )}
        </TabsContent>

        <TabsContent value="packages" className="mt-4">
          {packages.length ? (
            <ul className="space-y-2">
              {packages.map((p) => {
                const files = p.files as { name: string; sha256: string; bytes: number }[];
                return (
                  <li key={p.id} className="rounded-xl border bg-card p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <FileArchiveIcon className="size-4 text-muted-foreground" />
                      <span className="font-medium">{p.title}</span>
                      <span className="font-mono text-xs text-muted-foreground">{p.code}</span>
                      {p.isSimulated && <SimulatedBadge />}
                      <span className="ml-auto text-xs text-muted-foreground">{p.createdByEmail} · {formatIST(p.createdAt)}</span>
                    </div>
                    <ul className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                      {files.map((f) => (
                        <li key={f.name} className="flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{f.name}</p>
                            <p className="truncate font-mono text-[11px] text-muted-foreground" title={f.sha256}>sha256 {f.sha256.slice(0, 16)}… · {formatBytes(f.bytes)}</p>
                          </div>
                          {canExport && <ExportButton spec={{ type: "evidence_file", packageId: p.id, fileName: f.name }} label="Get" formats={false} size="sm" variant="secondary" />}
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon={FileArchiveIcon} title="No evidence packages yet" description="Generate one from a completed reconciliation or a campaign page." />
          )}
        </TabsContent>

        <TabsContent value="uploads" className="mt-4 space-y-4">
          {canReconcile && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Upload an independently preserved audience</CardTitle>
                <CardDescription className="text-xs">CSV with a header row (≤ 50 MB). The file is stored unaltered, hashed, and every value is kept as text. It is labelled a historical send-time snapshot only if you provide evidence and attest to it.</CardDescription>
              </CardHeader>
              <CardContent>
                <UploadForm connections={connections.map((c) => ({ id: c.id, name: c.name, mids: c.businessUnits.map((b) => b.mid) }))} />
              </CardContent>
            </Card>
          )}
          {uploads.length ? (
            <div className="overflow-hidden rounded-xl border bg-card">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Snapshot</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead>Verification</TableHead>
                    <TableHead>File SHA-256</TableHead>
                    <TableHead>Uploaded</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {uploads.map((u) => {
                    const up = (u.params as { upload?: { fileName: string; sha256: string; label: string; snapshotDate: string | null } }).upload;
                    return (
                      <TableRow key={u.id}>
                        <TableCell className="font-medium">{u.label}<p className="text-xs text-muted-foreground">{up?.fileName} · MID {u.mid}</p></TableCell>
                        <TableCell>{up?.label === "HISTORICAL_EVIDENCED" ? <Pill tone="info">historical (evidenced{up.snapshotDate ? `, ${up.snapshotDate.slice(0, 10)}` : ""})</Pill> : <Pill tone="muted">not established as historical</Pill>}</TableCell>
                        <TableCell className="tabular text-right">{fmt.format(u.recordsExtracted)}</TableCell>
                        <TableCell><VerificationBadge status={u.verificationStatus} /></TableCell>
                        <TableCell className="font-mono text-[11px]">{up?.sha256.slice(0, 20)}…</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{formatIST(u.createdAt)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No uploaded snapshots.</p>
          )}
        </TabsContent>

        {access && (
          <TabsContent value="access" className="mt-4">
            <div className="overflow-hidden rounded-xl border bg-card">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead>Time (IST)</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {access.rows.map((a) => (
                    <TableRow key={a.id} className="align-top">
                      <TableCell className="tabular whitespace-nowrap text-xs text-muted-foreground">{formatIST(a.createdAt, "dd MMM yyyy, hh:mm:ss a")}</TableCell>
                      <TableCell className="text-sm">{a.actorEmail}</TableCell>
                      <TableCell><Pill tone={a.action.includes("export") ? "warning" : a.action.includes("view") ? "info" : "neutral"}>{a.action}</Pill></TableCell>
                      <TableCell className="font-mono text-xs">{a.entityType}{a.entityId ? ` · ${a.entityId.slice(0, 24)}` : ""}</TableCell>
                      <TableCell className="max-w-md truncate font-mono text-[11px] text-muted-foreground" title={JSON.stringify(a.metadata)}>{JSON.stringify(a.metadata)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="border-t px-3"><UrlPagination total={access.total} page={page} pageSize={50} /></div>
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
