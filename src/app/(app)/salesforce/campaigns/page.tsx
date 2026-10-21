import Link from "next/link";
import { MailSearchIcon, SearchIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { contentStatusCounts, listEmailJobs, type ContentStatus } from "@/lib/services/salesforce/queries";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/empty-state";
import { UrlPagination } from "@/components/app/url-controls";
import { Pill } from "@/components/app/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExportButton } from "@/components/salesforce/export-button";
import { SimulatedBadge, fmt } from "@/components/salesforce/status";
import { formatIST, istLocalToUtc } from "@/lib/time";

export const metadata = { title: "Email Campaign Archive" };

const TRACK_ORDER = ["TRACKING_SENT", "TRACKING_NOTSENT", "TRACKING_BOUNCE", "TRACKING_OPEN", "TRACKING_CLICK", "TRACKING_UNSUB"];
const SHORT: Record<string, string> = { TRACKING_SENT: "S", TRACKING_NOTSENT: "N", TRACKING_BOUNCE: "B", TRACKING_OPEN: "O", TRACKING_CLICK: "C", TRACKING_UNSUB: "U" };

const CONTENT_LABEL: Record<ContentStatus, { label: string; short: string; tone: "success" | "warning" | "danger"; hint: string }> = {
  exact: { label: "Exact content", short: "exact", tone: "success", hint: "Archived email not modified after this send — this is what was sent." },
  edited: { label: "Edited after send", short: "edited later", tone: "warning", hint: "Archived email was modified after this send; the content sent may have differed." },
  missing: { label: "Content not available", short: "not available", tone: "danger", hint: "The email was deleted from Content Builder (or not archived); its body is not retrievable via the API." },
};

function TrackingDots({ tracking }: { tracking: { kind: string; status: string; verificationStatus: string }[] }) {
  return (
    <span className="inline-flex gap-0.5" aria-label="Archived tracking per event type">
      {TRACK_ORDER.map((k) => {
        const t = tracking.find((x) => x.kind === k);
        const cls = !t ? "border-dashed text-muted-foreground/60" : t.status === "NOT_RETRIEVABLE" ? "bg-muted text-muted-foreground" : t.status !== "EXTRACTED" ? "border-destructive/40 bg-destructive/10 text-destructive" : t.verificationStatus === "VERIFIED" ? "border-success/40 bg-success/10 text-success" : "border-warning/40 bg-warning/10 text-warning";
        const title = `${k.replace("TRACKING_", "").toLowerCase()}: ${!t ? "not archived" : t.status === "EXTRACTED" ? t.verificationStatus.toLowerCase().replace("_", " ") : t.status.toLowerCase().replace("_", " ")}`;
        return (
          <span key={k} title={title} className={`grid size-5 place-items-center rounded border text-[10px] font-semibold ${cls}`}>
            {SHORT[k]}
          </span>
        );
      })}
    </span>
  );
}

export default async function CampaignArchivePage({ searchParams }: PageProps<"/salesforce/campaigns">) {
  const user = await requirePageUser("archive:read");
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string) : undefined);
  const page = Math.max(1, Number(sp.page) || 1);
  const q = str("q");
  const from = str("from");
  const to = str("to");
  const mid = str("mid");
  const content = (["exact", "edited", "missing"] as const).find((c) => c === str("content")) as ContentStatus | undefined;
  const counts = await contentStatusCounts();
  const { total, rows } = await listEmailJobs({ q, mid, content, from: from ? istLocalToUtc(`${from}T00:00`) : undefined, to: to ? istLocalToUtc(`${to}T23:59`) : undefined, page, pageSize: 50 });

  return (
    <div className="animate-in-fade">
      <PageHeader
        title="Email Campaign Archive"
        description="Archived Email Studio send jobs (SOAP Send objects) with Salesforce's own counters. A send job is not an audience snapshot: recipient-level evidence comes from archived tracking events."
        actions={hasPermission(user.role, "archive:export") ? <ExportButton spec={{ type: "email_jobs", ...(mid ? { mid } : {}) }} label="Export jobs" /> : undefined}
      />
      <form className="mb-3 flex flex-wrap items-end gap-2" method="get">
        <div className="relative w-full sm:w-72">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input name="q" defaultValue={q} placeholder="JobID, EmailID, subject or email name" className="h-9 bg-surface pl-8" />
        </div>
        <label className="text-xs text-muted-foreground">
          From
          <Input type="date" name="from" defaultValue={from} className="h-9 w-40" />
        </label>
        <label className="text-xs text-muted-foreground">
          To
          <Input type="date" name="to" defaultValue={to} className="h-9 w-40" />
        </label>
        <label className="text-xs text-muted-foreground">
          MID
          <Input name="mid" defaultValue={mid} inputMode="numeric" className="h-9 w-32" />
        </label>
        {content && <input type="hidden" name="content" value={content} />}
        <Button type="submit" size="sm" variant="outline">Apply</Button>
        {(q || from || to || mid) && (
          <Button asChild size="sm" variant="ghost"><Link href="/salesforce/campaigns">Clear</Link></Button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{fmt.format(total)} send job(s) · S N B O C U = sent · not-sent · bounce · open · click · unsub tracking</span>
      </form>
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="mr-1 text-muted-foreground">Email content:</span>
        {([undefined, "exact", "edited", "missing"] as const).map((c) => {
          const label = c === undefined ? "All" : CONTENT_LABEL[c].label;
          const n = c === undefined ? Object.values(counts).reduce((a, b) => a + (b ?? 0), 0) : (counts[c] ?? 0);
          const params = new URLSearchParams(Object.entries({ q, from, to, mid, content: c }).filter(([, v]) => v) as [string, string][]);
          return (
            <Link key={c ?? "all"} href={`/salesforce/campaigns${params.toString() ? `?${params}` : ""}`} className={`rounded-md border px-2 py-0.5 ${content === c ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}>
              {label} ({fmt.format(n)})
            </Link>
          );
        })}
      </div>
      {rows.length ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>JobID</TableHead>
                  <TableHead>Sent (IST)</TableHead>
                  <TableHead className="text-right">Targeted</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Excluded</TableHead>
                  <TableHead className="text-right">Unique opens</TableHead>
                  <TableHead>Content</TableHead>
                  <TableHead>Recipient evidence</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const c = r.counters as Record<string, string | null>;
                  const n = (k: string) => (c[k] !== undefined && c[k] !== null && c[k] !== "" ? fmt.format(Number(c[k])) : "—");
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-[340px]">
                        <Link href={`/salesforce/campaigns/${r.mid}/${r.jobId}`} className="block truncate font-medium hover:underline">{r.emailName ?? "(unnamed email)"}</Link>
                        <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">{r.subject}{r.isSimulated && <SimulatedBadge />}</p>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.jobId}<p className="text-muted-foreground">MID {r.mid}</p></TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatIST(r.sentDate ?? r.sendDate)}</TableCell>
                      <TableCell className="tabular text-right">{n("NumberTargeted")}</TableCell>
                      <TableCell className="tabular text-right">{n("NumberSent")}</TableCell>
                      <TableCell className="tabular text-right">{n("NumberExcluded")}</TableCell>
                      <TableCell className="tabular text-right">{n("UniqueOpens")}</TableCell>
                      <TableCell><span title={CONTENT_LABEL[r.contentStatus].hint}><Pill tone={CONTENT_LABEL[r.contentStatus].tone}>{CONTENT_LABEL[r.contentStatus].short}</Pill></span></TableCell>
                      <TableCell><TrackingDots tracking={r.tracking} /></TableCell>
                      <TableCell><Pill tone="muted">{r.status ?? "—"}</Pill></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-3">
            <UrlPagination total={total} page={page} pageSize={50} />
          </div>
        </div>
      ) : (
        <EmptyState icon={MailSearchIcon} title={q || from || to ? "No send jobs match" : "No send jobs archived yet"} description="Run a backup with “Email send jobs” selected." />
      )}
    </div>
  );
}
