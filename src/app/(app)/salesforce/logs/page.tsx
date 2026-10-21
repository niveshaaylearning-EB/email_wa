import Link from "next/link";
import { ScrollTextIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { listExtractionErrors, listExtractionLogs } from "@/lib/services/salesforce/queries";
import { PageHeader, SectionTitle } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/empty-state";
import { UrlPagination, UrlSearch } from "@/components/app/url-controls";
import { Pill } from "@/components/app/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatIST } from "@/lib/time";
import { cn } from "@/lib/utils";

export const metadata = { title: "Extraction logs" };

export default async function LogsPage({ searchParams }: PageProps<"/salesforce/logs">) {
  await requirePageUser("archive:read");
  const sp = await searchParams;
  const level = typeof sp.level === "string" && ["info", "warn", "error"].includes(sp.level) ? sp.level : undefined;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const backupJobId = typeof sp.backupJobId === "string" ? sp.backupJobId : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const [logs, errors] = await Promise.all([listExtractionLogs({ level, q, backupJobId, page, pageSize: 100 }), listExtractionErrors(50)]);
  const link = (l?: string) => {
    const p = new URLSearchParams();
    if (l) p.set("level", l);
    if (q) p.set("q", q);
    if (backupJobId) p.set("backupJobId", backupJobId);
    return `/salesforce/logs${p.toString() ? `?${p}` : ""}`;
  };

  return (
    <div className="animate-in-fade space-y-6">
      <PageHeader title="Extraction logs" description="Per-dataset extraction events and every Salesforce API error (credentials and personal data are masked)." />
      <section>
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
          <UrlSearch placeholder="Search log messages" />
          <div className="flex gap-1">
            {[undefined, "info", "warn", "error"].map((l) => (
              <Link key={l ?? "all"} href={link(l)} className={cn("rounded-md border px-2 py-0.5 text-xs", level === l ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}>{l ?? "all"}</Link>
            ))}
          </div>
          {backupJobId && <Link href="/salesforce/logs" className="text-xs text-primary hover:underline">clear job filter</Link>}
        </div>
        {logs.rows.length ? (
          <div className="overflow-hidden rounded-xl border bg-card">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Time (IST)</TableHead>
                  <TableHead>Level</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Backup / dataset</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.rows.map((l) => (
                  <TableRow key={String(l.id)} className="align-top">
                    <TableCell className="tabular whitespace-nowrap text-xs text-muted-foreground">{formatIST(l.createdAt, "dd MMM yyyy, hh:mm:ss a")}</TableCell>
                    <TableCell><Pill tone={l.level === "error" ? "danger" : l.level === "warn" ? "warning" : "muted"}>{l.level}</Pill></TableCell>
                    <TableCell className="text-sm">
                      {l.message}
                      {Object.keys(l.data as object).length > 0 && <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={JSON.stringify(l.data)}>{JSON.stringify(l.data)}</p>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{l.backupJobId ? <Link className="hover:underline" href={`/salesforce/backups/${l.backupJobId}`}>{l.backupJobId.slice(-8)}</Link> : "—"}{l.datasetId ? ` / ${l.datasetId.slice(-8)}` : ""}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="border-t px-3"><UrlPagination total={logs.total} page={page} pageSize={100} /></div>
          </div>
        ) : (
          <EmptyState icon={ScrollTextIcon} title="No log entries" />
        )}
      </section>
      <section>
        <SectionTitle title="Recent API errors" description="Including errors later recovered by retry, restart or token refresh." />
        {errors.length ? (
          <div className="overflow-hidden rounded-xl border bg-card">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Time (IST)</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Object</TableHead>
                  <TableHead>MID</TableHead>
                  <TableHead>Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {errors.map((e) => (
                  <TableRow key={e.id} className="align-top">
                    <TableCell className="tabular whitespace-nowrap text-xs text-muted-foreground">{formatIST(e.createdAt, "dd MMM, hh:mm:ss a")}</TableCell>
                    <TableCell><Pill tone={e.retryable ? "warning" : "danger"}>{e.code}{e.httpStatus ? ` ${e.httpStatus}` : ""}</Pill></TableCell>
                    <TableCell className="font-mono text-xs">{e.objectType}{e.pageNo ? ` p${e.pageNo}` : ""}</TableCell>
                    <TableCell className="font-mono text-xs">{e.mid}</TableCell>
                    <TableCell className="max-w-xl text-xs text-muted-foreground">{e.message}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No API errors recorded.</p>
        )}
      </section>
    </div>
  );
}
