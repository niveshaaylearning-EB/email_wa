import Link from "next/link";
import { GitCompareArrowsIcon, InfoIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { requestMeta } from "@/lib/auth/session";
import { getEmailJob } from "@/lib/services/salesforce/queries";
import { datasetDrawerData } from "@/lib/services/salesforce/views";
import { archiveAudit } from "@/lib/services/salesforce/audit";
import { PageHeader } from "@/components/app/page-header";
import { KpiCard } from "@/components/app/kpi-card";
import { Notice } from "@/components/app/empty-state";
import { Pill } from "@/components/app/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HBarList } from "@/components/charts/charts";
import { ActionButton } from "@/components/salesforce/action-button";
import { ExportButton } from "@/components/salesforce/export-button";
import { DatasetDrawer } from "@/components/salesforce/dataset-drawer";
import { PreviewFrame } from "@/components/salesforce/preview-frame";
import { emailForJob } from "@/lib/services/salesforce/content";
import { DatasetStatusBadge, SimulatedBadge, VerificationBadge, fmt } from "@/components/salesforce/status";
import { formatIST } from "@/lib/time";

export const metadata = { title: "Campaign" };

const KINDS = [
  ["TRACKING_SENT", "SENT", "Sent events"],
  ["TRACKING_NOTSENT", "NOTSENT", "Not-sent events"],
  ["TRACKING_BOUNCE", "BOUNCE", "Bounce events"],
  ["TRACKING_OPEN", "OPEN", "Open events"],
  ["TRACKING_CLICK", "CLICK", "Click events"],
  ["TRACKING_UNSUB", "UNSUB", "Unsubscribe events"],
] as const;

export default async function CampaignPage({ params }: PageProps<"/salesforce/campaigns/[mid]/[jobId]">) {
  const user = await requirePageUser("archive:read");
  const { mid, jobId } = await params;
  const { job, current, stats, asset, recons, clicksByUrl } = await getEmailJob(mid, jobId);
  await archiveAudit({ actor: user, action: "archive.view.campaign", entityType: "salesforce_email_job", entityId: `${mid}:${jobId}`, ...(await requestMeta()) });
  const c = job.counters as Record<string, string | null>;
  const num = (k: string) => (c[k] !== undefined && c[k] !== null && c[k] !== "" ? Number(c[k]) : null);
  const canExport = hasPermission(user.role, "archive:export");
  const canReconcile = hasPermission(user.role, "archive:reconcile");
  const sentStat = stats.find((s) => s.eventType === "SENT");
  const targeted = num("NumberTargeted");
  const sent = num("NumberSent");
  const content = await emailForJob(job);

  return (
    <div className="animate-in-fade space-y-6">
      <PageHeader
        eyebrow={<Link href="/salesforce/campaigns" className="hover:underline">Email Campaign Archive</Link>}
        title={<span className="inline-flex flex-wrap items-center gap-2">{job.emailName ?? "(unnamed email)"}{job.isSimulated && <SimulatedBadge />}</span>}
        description={<>JobID <span className="font-mono">{job.jobId}</span> · MID <span className="font-mono">{job.mid}</span> · subject “{job.subject ?? "—"}” · from {job.fromName} &lt;{job.fromAddress}&gt;</>}
        actions={
          <>
            {canReconcile && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/salesforce/audit/reconciliations/new?mid=${job.mid}&jobId=${job.jobId}`}><GitCompareArrowsIcon /> Reconcile audience</Link>
              </Button>
            )}
            {canExport && <ExportButton spec={{ type: "tracking", mid: job.mid, jobId: job.jobId }} label="Recipient events" />}
            {canReconcile && <ActionButton path="/api/v1/salesforce/evidence" body={{ kind: "CAMPAIGN", mid: job.mid, jobId: job.jobId }} label="Evidence package" icon="evidence" variant="default" />}
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Send time (IST)" value={<span className="text-lg">{formatIST(job.sentDate ?? job.sendDate)}</span>} hint={`scheduled ${formatIST(job.sendDate)} · status ${job.status ?? "—"}`} />
        <KpiCard label="Salesforce: targeted → sent" value={`${targeted !== null ? fmt.format(targeted) : "—"} → ${sent !== null ? fmt.format(sent) : "—"}`} hint="Send object counters (aggregate, as reported)" />
        <KpiCard label="Archived SentEvents" value={sentStat ? fmt.format(sentStat.events) : "—"} hint={sentStat ? `${fmt.format(sentStat.subscribers)} distinct subscribers${sentStat.rows !== sentStat.events ? ` · ${sentStat.rows - sentStat.events} duplicate row(s) kept` : ""}` : "not archived"} tone={sentStat && sent !== null ? (sentStat.events === sent ? "success" : "warning") : "default"} />
        <KpiCard label="Reconciliations" value={fmt.format(recons.length)} hint={recons[0] ? `latest ${recons[0].code}` : "none yet"} href={recons[0] ? `/salesforce/audit/reconciliations/${recons[0].id}` : undefined} />
      </div>

      <Notice tone="info" icon={InfoIcon} title="How to read this page">
        Counters come from Salesforce’s Send object. Recipient rows come from archived tracking events. A SentEvent shows Salesforce processed a send for that subscriber — it does not prove inbox delivery. The audience at send time is not stored in the Send object.
      </Notice>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">The email that was sent</h2>
            <p className="text-xs text-muted-foreground">
              EmailID <span className="font-mono">{job.emailId ?? "—"}</span>
              {content?.email && <> · archived from Salesforce’s Email object · last modified in Salesforce {formatIST(content.email.modifiedAt)} · SHA-256 <span className="font-mono">{content.email.htmlSha256?.slice(0, 12)}…</span></>}
              {!content?.email && content?.asset && <> · archived from Content Builder (“{content.asset.name}”)</>}
            </p>
          </div>
          {content?.modifiedAfterSend === false && <Pill tone="success" dot>Unchanged since the send</Pill>}
          {content?.modifiedAfterSend === true && <Pill tone="warning" dot>Edited after the send — may differ from what was sent</Pill>}
        </div>
        {content?.email ? (
          <PreviewFrame src={`/api/v1/salesforce/emails/${content.email.id}/preview`} height={620} />
        ) : content?.asset ? (
          <PreviewFrame src={`/api/v1/salesforce/assets/${content.asset.id}/preview`} height={620} />
        ) : (
          <Notice tone="warning" title="Email content not archived yet">
            {content?.emailRecord ? "Salesforce returned this email without an HTML or text body." : "Run a backup with “Email content of every sent email” selected. If it still does not appear, the email was deleted in Salesforce and its content is no longer retrievable."}
          </Notice>
        )}
        <p className="text-xs text-muted-foreground">Personalisation such as %%FirstName%% is shown as the template placeholder; Salesforce does not keep a copy of each individually rendered email.</p>
      </section>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">Recipient-level tracking archived for this JobID</CardTitle>
            <CardDescription className="text-xs">Distinct events exclude rows Salesforce returned twice (those rows are still preserved).</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Extraction</TableHead>
                  <TableHead>Verification</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Distinct events</TableHead>
                  <TableHead className="text-right">Subscribers</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {KINDS.map(([kind, ev, label]) => {
                  const d = current.find((x) => x.kind === kind);
                  const s = stats.find((x) => x.eventType === ev);
                  return (
                    <TableRow key={kind}>
                      <TableCell className="font-medium">{label}</TableCell>
                      <TableCell>{d ? <DatasetStatusBadge status={d.status} /> : <Pill tone="muted">not archived</Pill>}</TableCell>
                      <TableCell>{d ? <VerificationBadge status={d.verificationStatus} /> : "—"}</TableCell>
                      <TableCell className="tabular text-right">{s ? fmt.format(s.rows) : d?.status === "NOT_RETRIEVABLE" ? <span className="text-xs text-muted-foreground">not retrievable</span> : "—"}</TableCell>
                      <TableCell className="tabular text-right">{s ? fmt.format(s.events) : "—"}</TableCell>
                      <TableCell className="tabular text-right">{s ? fmt.format(s.subscribers) : "—"}</TableCell>
                      <TableCell className="text-right">{d && <DatasetDrawer d={datasetDrawerData(d)} canExport={canExport} canReconcile={canReconcile} />}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Send object counters</CardTitle>
            <CardDescription className="text-xs">Exactly as returned by Salesforce. Aggregates cannot be attributed to individual recipients.</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="space-y-1 text-sm">
              {Object.entries(c).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="tabular font-medium">{v === null || v === "" ? "—" : fmt.format(Number(v))}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Most clicked links</CardTitle>
          </CardHeader>
          <CardContent>{clicksByUrl.length ? <HBarList items={clicksByUrl.map((u) => ({ label: u.url, value: u.count }))} /> : <p className="text-sm text-muted-foreground">No click events archived.</p>}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Related evidence</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>Template: {asset ? <Link className="text-primary hover:underline" href={`/salesforce/templates/${asset.id}`}>{asset.name}</Link> : job.emailId ? <span className="text-muted-foreground">EmailID {job.emailId} not archived from Content Builder</span> : "—"}</p>
            <div>
              <p className="mb-1 text-muted-foreground">Reconciliations</p>
              {recons.length ? (
                <ul className="space-y-1">
                  {recons.map((r) => (
                    <li key={r.id}>
                      <Link className="font-mono text-xs text-primary hover:underline" href={`/salesforce/audit/reconciliations/${r.id}`}>{r.code}</Link> <span className="text-xs">{r.name}</span> <Pill tone="muted">{r.status.toLowerCase()}</Pill>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">None.</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Archived from dataset <span className="font-mono">{job.datasetId}</span>; first seen {formatIST(job.firstSeenAt)}, last refreshed {formatIST(job.lastSeenAt)}.</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
