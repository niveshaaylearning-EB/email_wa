import Link from "next/link";
import { InfoIcon, TriangleAlertIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { requestMeta } from "@/lib/auth/session";
import { getReconciliation, reconciliationResults } from "@/lib/services/salesforce/queries";
import { archiveAudit } from "@/lib/services/salesforce/audit";
import { RECON_CLASS_LABELS, RECON_FLAG_LABELS, type ReconClass, type ReconSummary } from "@/lib/domain/salesforce-reconcile";
import { PageHeader, SectionTitle } from "@/components/app/page-header";
import { KpiCard } from "@/components/app/kpi-card";
import { EmptyState, Notice } from "@/components/app/empty-state";
import { UrlPagination, UrlSearch } from "@/components/app/url-controls";
import { Pill } from "@/components/app/status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { HBarList } from "@/components/charts/charts";
import { ActionButton, LiveRefresh } from "@/components/salesforce/action-button";
import { ExportButton } from "@/components/salesforce/export-button";
import { SimulatedBadge, VerificationBadge, fmt } from "@/components/salesforce/status";
import { formatIST } from "@/lib/time";
import { cn } from "@/lib/utils";

export const metadata = { title: "Reconciliation" };

const CLASS_ORDER: ReconClass[] = ["MATCHED_SENT", "AUDIENCE_NO_SENT_EVENT", "UNRESOLVED", "RETENTION_UNAVAILABLE", "DUPLICATE_AUDIENCE_ROW", "INVALID_IDENTIFIER", "TRACKING_NOT_IN_AUDIENCE"];
const CLASS_TONE: Record<ReconClass, "success" | "info" | "warning" | "neutral" | "muted" | "danger"> = {
  MATCHED_SENT: "success",
  AUDIENCE_NO_SENT_EVENT: "info",
  UNRESOLVED: "warning",
  RETENTION_UNAVAILABLE: "neutral",
  DUPLICATE_AUDIENCE_ROW: "muted",
  INVALID_IDENTIFIER: "danger",
  TRACKING_NOT_IN_AUDIENCE: "info",
};
const CLASS_COLOR: Record<ReconClass, string> = { MATCHED_SENT: "var(--success)", AUDIENCE_NO_SENT_EVENT: "var(--info)", UNRESOLVED: "var(--warning)", RETENTION_UNAVAILABLE: "var(--viz-axis)", DUPLICATE_AUDIENCE_ROW: "var(--muted-foreground)", INVALID_IDENTIFIER: "var(--destructive)", TRACKING_NOT_IN_AUDIENCE: "var(--viz-2)" };

/** Salesforce counters that can explain an audience → sent gap in aggregate. */
const AGG_KEYS: [string, string][] = [
  ["NumberTargeted", "Targeted"],
  ["Duplicates", "Duplicates removed"],
  ["MissingAddresses", "Missing addresses"],
  ["InvalidAddresses", "Invalid addresses"],
  ["ExistingUnsubscribes", "Existing unsubscribes"],
  ["ExistingUndeliverables", "Existing undeliverables"],
  ["NumberExcluded", "Excluded"],
  ["NumberErrored", "Errored"],
  ["NumberSent", "Sent"],
];

type FullSummary = ReconSummary & {
  jobs: { jobId: string; emailName: string | null; subject: string | null; sendDate: string | null; counters: Record<string, string | null> }[];
  unavailableJobs: string[];
  missingSendObjects: string[];
  trackingAvailability: string;
  datasets: { audience: { id: string; label: string; extractedAt: string | null; verification: string }; tracking: { id: string; kind: string; jobId: string; status: string; verification: string; records: number }[] };
};

export default async function ReconciliationPage({ params, searchParams }: PageProps<"/salesforce/audit/reconciliations/[id]">) {
  const user = await requirePageUser("archive:read");
  const { id } = await params;
  const sp = await searchParams;
  const { rec, audience, packages } = await getReconciliation(id);
  const running = rec.status === "QUEUED" || rec.status === "RUNNING";
  const cls = typeof sp.class === "string" && CLASS_ORDER.includes(sp.class as ReconClass) ? sp.class : undefined;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const page = Math.max(1, Number(sp.page) || 1);
  const results = rec.status === "COMPLETED" ? await reconciliationResults(id, { classification: cls, q, page, pageSize: 50 }) : null;
  await archiveAudit({ actor: user, action: "archive.view.reconciliation", entityType: "salesforce_reconciliation", entityId: id, metadata: { code: rec.code, class: cls ?? null, q: q ?? null }, ...(await requestMeta()) });
  const s = rec.summary as unknown as FullSummary;
  const evidence = rec.audienceEvidence as Record<string, string | boolean | null>;
  const canExport = hasPermission(user.role, "archive:export");
  const canReconcile = hasPermission(user.role, "archive:reconcile");
  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { class: cls, q, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `?${p.toString()}`;
  };

  return (
    <div className="animate-in-fade space-y-6">
      <PageHeader
        eyebrow={<Link href="/salesforce/audit" className="hover:underline">SEBI Audit Center</Link>}
        title={<span className="inline-flex flex-wrap items-center gap-2">{rec.name}{rec.isSimulated && <SimulatedBadge />}</span>}
        description={<><span className="font-mono">{rec.code}</span> · JobID {rec.jobIds.join(", ")} · MID {rec.mid} · by {rec.createdByEmail} · {formatIST(rec.createdAt)}</>}
        actions={
          <>
            <LiveRefresh active={running} intervalMs={2500} />
            {rec.status === "COMPLETED" && canExport && <ExportButton spec={{ type: "reconciliation", reconciliationId: rec.id, ...(cls ? { classification: cls } : {}) }} label={cls ? "Export filtered" : "Export recipients"} />}
            {rec.status === "COMPLETED" && canReconcile && <ActionButton path="/api/v1/salesforce/evidence" body={{ kind: "RECONCILIATION", reconciliationId: rec.id }} label="Generate evidence package" icon="evidence" variant="default" />}
          </>
        }
      />

      {running && <Notice tone="info" title="Reconciliation running">Loading the audience and recipient-level tracking. This page refreshes automatically.</Notice>}
      {rec.status === "FAILED" && <Notice tone="danger" title="Reconciliation failed">{rec.errorMessage}</Notice>}

      {rec.status === "COMPLETED" && (
        <>
          <Notice tone={rec.audienceLabel === "HISTORICAL_EVIDENCED" ? "info" : "warning"} icon={rec.audienceLabel === "HISTORICAL_EVIDENCED" ? InfoIcon : TriangleAlertIcon} title={rec.audienceLabel === "HISTORICAL_EVIDENCED" ? "Audience labelled as the send-time snapshot (claimed with evidence)" : "Audience is a current-state copy — not established as the send-time audience"}>
            {audience?.label} · {fmt.format(audience?.recordsExtracted ?? 0)} rows · extracted {formatIST(audience?.finishedAt)}
            {evidence.claim ? <> · evidence: “{String(evidence.claim)}” (attested by {String(evidence.attestedBy)})</> : null}
            {evidence.extractedAfterSend ? " · extracted AFTER the send" : ""}
          </Notice>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Audience rows" value={fmt.format(s.audienceRows)} hint={`${fmt.format(s.uniqueAudienceIdentities)} unique identities`} />
            <KpiCard label="Unique recipients with a SentEvent" value={fmt.format(s.uniqueRecipientsWithSentEvent)} hint={`${fmt.format(s.observedSentEvents)} SentEvents observed`} tone="brand" />
            <KpiCard label="Audience without a SentEvent" value={fmt.format(s.audienceWithoutSentEvent)} hint={`${fmt.format(s.withVerifiedNotSentEvidence)} with NotSentEvent · ${fmt.format(s.withPossibleExplanationOnly)} possible explanation only`} tone="warning" />
            <KpiCard label="Unresolved" value={fmt.format(s.unresolved)} hint="No evidence either way — never assumed suppressed or excluded" tone={s.unresolved ? "warning" : "success"} />
          </div>

          <div className="grid gap-4 xl:grid-cols-5">
            <Card className="xl:col-span-3">
              <CardHeader>
                <CardTitle className="text-sm">Bridge: audience rows → unique recipients with a SentEvent</CardTitle>
                <CardDescription className="text-xs">Derived from archived rows and events. Each step links to the recipients behind it.</CardDescription>
              </CardHeader>
              <CardContent>
                <ol className="space-y-1">
                  {s.bridge.map((b) => (
                    <li key={b.label} className={cn("flex items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-sm", b.subtotal ? "bg-muted/60 font-semibold" : "")}>
                      <span>{b.label}</span>
                      <span className={cn("tabular", b.value < 0 && "text-muted-foreground")}>{b.value < 0 ? `−${fmt.format(-b.value)}` : fmt.format(b.value)}</span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
            <Card className="xl:col-span-2">
              <CardHeader>
                <CardTitle className="text-sm">Salesforce’s own Send counters</CardTitle>
                <CardDescription className="text-xs">Source records. They may explain the gap in aggregate but cannot be attributed to individual recipients.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {s.jobs.map((j) => (
                  <div key={j.jobId}>
                    <p className="mb-1 text-xs font-medium"><Link className="font-mono hover:underline" href={`/salesforce/campaigns/${rec.mid}/${j.jobId}`}>{j.jobId}</Link> · {j.emailName}</p>
                    <dl className="space-y-0.5 text-sm">
                      {AGG_KEYS.filter(([k]) => j.counters[k] !== undefined).map(([k, label]) => (
                        <div key={k} className="flex justify-between"><dt className="text-muted-foreground">{label}</dt><dd className="tabular">{j.counters[k] ? fmt.format(Number(j.counters[k])) : "—"}</dd></div>
                      ))}
                    </dl>
                  </div>
                ))}
                {s.missingSendObjects.length > 0 && <p className="text-xs text-warning">No Send object archived for {s.missingSendObjects.join(", ")}.</p>}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Classification</CardTitle>
              </CardHeader>
              <CardContent>
                <HBarList items={CLASS_ORDER.map((c) => ({ label: RECON_CLASS_LABELS[c], value: s.byClass[c] ?? 0, color: CLASS_COLOR[c], swatch: CLASS_COLOR[c] }))} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Evidence flags</CardTitle>
                <CardDescription className="text-xs">Verified recipient-level evidence vs possible explanations.</CardDescription>
              </CardHeader>
              <CardContent>
                {Object.keys(s.flagCounts).length ? (
                  <dl className="space-y-1 text-sm">
                    {Object.entries(s.flagCounts).sort((a, b) => b[1] - a[1]).map(([f, n]) => (
                      <div key={f} className="flex justify-between gap-3"><dt className="text-muted-foreground">{RECON_FLAG_LABELS[f] ?? f.replace(/_/g, " ").toLowerCase()}</dt><dd className="tabular font-medium">{fmt.format(n)}</dd></div>
                    ))}
                  </dl>
                ) : (
                  <p className="text-sm text-muted-foreground">No evidence flags.</p>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Evidence limitations</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc space-y-1 pl-4 text-sm">
                {(rec.limitations as string[]).map((l) => <li key={l}>{l}</li>)}
              </ul>
              <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span>Datasets:</span>
                <span>audience <VerificationBadge status={s.datasets.audience.verification} /></span>
                {s.datasets.tracking.map((t) => (
                  <span key={t.id}>{t.kind.replace("TRACKING_", "").toLowerCase()} {t.jobId} <VerificationBadge status={t.verification} /></span>
                ))}
              </div>
              <p className="mt-2 font-mono text-[11px] text-muted-foreground">inputs sha256 {rec.inputsSha256}</p>
            </CardContent>
          </Card>

          <section>
            <SectionTitle title="Recipients" description="Each audience row and each tracking-only recipient, with its evidence." />
            <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:items-center">
              <UrlSearch placeholder="Search identity" />
              <div className="flex flex-wrap gap-1">
                <Link href={qs({ class: undefined, page: undefined })} className={cn("rounded-md border px-2 py-0.5 text-xs", !cls ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}>All</Link>
                {CLASS_ORDER.filter((c) => s.byClass[c]).map((c) => (
                  <Link key={c} href={qs({ class: c, page: undefined })} className={cn("rounded-md border px-2 py-0.5 text-xs", cls === c ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted")}>
                    {RECON_CLASS_LABELS[c]} ({fmt.format(s.byClass[c])})
                  </Link>
                ))}
              </div>
            </div>
            {results?.rows.length ? (
              <div className="overflow-hidden rounded-xl border bg-card">
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader className="bg-muted/50">
                      <TableRow>
                        <TableHead>Identity</TableHead>
                        <TableHead>Classification</TableHead>
                        <TableHead>Evidence</TableHead>
                        <TableHead className="text-right">SentEvents</TableHead>
                        <TableHead>First sent (IST)</TableHead>
                        <TableHead>Audience row</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {results.rows.map((r) => {
                        const ev = r.evidence as Record<string, unknown>;
                        return (
                          <TableRow key={String(r.id)} className="align-top">
                            <TableCell>{r.identity ? <Link className="font-mono text-xs hover:underline" href={`/salesforce/tracking?subscriberKey=${encodeURIComponent(r.rawIdentity ?? r.identity)}`}>{r.rawIdentity ?? r.identity}</Link> : <span className="text-xs text-muted-foreground">{r.rawIdentity === null ? "null" : `"${r.rawIdentity}"`}</span>}</TableCell>
                            <TableCell><Pill tone={CLASS_TONE[r.classification as ReconClass]}>{RECON_CLASS_LABELS[r.classification as ReconClass]}</Pill></TableCell>
                            <TableCell className="max-w-[360px] text-xs">
                              {r.flags.length ? <span className="flex flex-wrap gap-1">{r.flags.map((f) => <Pill key={f} tone={f === "NOTSENT_EVENT" ? "info" : f.includes("BOUNCE") || f.includes("UNSUB") ? "warning" : "muted"}>{f.replace(/_/g, " ").toLowerCase()}</Pill>)}</span> : <span className="text-muted-foreground">—</span>}
                              {typeof ev.evidenceLevel === "string" && <p className="mt-1 text-muted-foreground">{ev.evidenceLevel.replace(/_/g, " ").toLowerCase()}</p>}
                            </TableCell>
                            <TableCell className="tabular text-right">{r.sentEventCount}</TableCell>
                            <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{r.firstSentAt ? formatIST(r.firstSentAt, "dd MMM yyyy, hh:mm a") : "—"}</TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">{(r.audienceRefs as { page: number; row: number }[]).map((a) => `p${a.page}·r${a.row}`).join(", ") || "—"}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                <div className="border-t px-3"><UrlPagination total={results.total} page={page} pageSize={50} /></div>
              </div>
            ) : (
              <EmptyState compact title="No recipients in this view" />
            )}
          </section>

          {packages.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Evidence packages: {packages.map((p) => <Link key={p.id} className="mr-2 font-mono text-primary hover:underline" href="/salesforce/audit?tab=packages">{p.code}</Link>)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
