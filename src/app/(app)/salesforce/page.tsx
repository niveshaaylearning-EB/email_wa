import Link from "next/link";
import { ArchiveIcon, BadgeCheckIcon, DatabaseBackupIcon, HardDriveIcon, MailSearchIcon, ShieldAlertIcon, TriangleAlertIcon, UserSearchIcon, CloudCogIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { archiveOverview, trackingByMonth, trackingCoverage } from "@/lib/services/salesforce/queries";
import { archiveHealth } from "@/lib/services/salesforce/health";
import { PageHeader, SectionTitle } from "@/components/app/page-header";
import { KpiCard } from "@/components/app/kpi-card";
import { EmptyState, Notice } from "@/components/app/empty-state";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ChartCard, HBarList, TrendChart } from "@/components/charts/charts";
import { JobStatusBadge, SimulatedBadge, VerificationBadge, fmt, formatBytes } from "@/components/salesforce/status";
import { formatIST, relativeTime } from "@/lib/time";

export const metadata = { title: "Salesforce Archive" };

const VERIFY_ORDER = ["VERIFIED", "PARTIALLY_VERIFIED", "UNVERIFIED", "FAILED", "NOT_ACCESSIBLE", "NOT_RETRIEVABLE"] as const;
const VERIFY_COLOR: Record<string, string> = { VERIFIED: "var(--success)", PARTIALLY_VERIFIED: "var(--warning)", UNVERIFIED: "var(--muted-foreground)", FAILED: "var(--destructive)", NOT_ACCESSIBLE: "var(--destructive)", NOT_RETRIEVABLE: "var(--viz-axis)" };

export default async function ArchiveOverviewPage() {
  const user = await requirePageUser("archive:read");
  const [o, coverage, months, health] = await Promise.all([archiveOverview(), trackingCoverage(), trackingByMonth(), archiveHealth()]);
  const totalDatasets = Object.values(o.verification).reduce((a, b) => a + b, 0);
  const gaps = (o.verification.NOT_ACCESSIBLE ?? 0) + (o.verification.FAILED ?? 0) + (o.verification.NOT_RETRIEVABLE ?? 0);
  const canManage = hasPermission(user.role, "archive:manage");
  const connected = o.connections.some((c) => c.status === "CONNECTED");

  return (
    <div className="animate-in-fade space-y-6">
      <PageHeader
        eyebrow={<span className="inline-flex items-center gap-1.5"><ArchiveIcon className="size-3.5" /> Salesforce Archive · read-only</span>}
        title="Archive overview"
        description="Independent, verifiable copy of Niveshaay's Salesforce Marketing Cloud history for internal compliance and SEBI inspections. Nothing in Salesforce is ever modified from here."
        actions={
          <>
            <Button asChild variant="outline" size="sm"><Link href="/salesforce/audit">SEBI Audit Center</Link></Button>
            {canManage && <Button asChild size="sm"><Link href="/salesforce/backups"><DatabaseBackupIcon /> Backup Center</Link></Button>}
          </>
        }
      />

      {!health.encodingOk && <Notice tone="danger" icon={ShieldAlertIcon} title="Database encoding cannot store all archived characters">{health.encodingMessage}</Notice>}
      {o.hasSimulated && (
        <Notice tone="warning" icon={TriangleAlertIcon} title="This archive contains SIMULATED data">
          Datasets from the development simulator are marked <SimulatedBadge className="mx-1" /> everywhere. They are synthetic and must never be used as evidence.
        </Notice>
      )}
      {!o.connections.length ? (
        <EmptyState
          icon={CloudCogIcon}
          title="No Salesforce connection yet"
          description="Configure the Marketing Cloud Installed Package (server-to-server, read scopes) to start archiving. Full UI access does not imply API access — an administrator must create the package."
          action={<Button asChild size="sm"><Link href="/salesforce/connection">Set up connection</Link></Button>}
        />
      ) : !connected ? (
        <Notice tone="info" icon={CloudCogIcon} title="Connection not verified" action={<Button asChild size="sm" variant="outline"><Link href="/salesforce/connection">Open</Link></Button>}>
          Run “Test connection” to confirm authentication and read permissions before backing up.
        </Notice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Last successful backup"
          icon={DatabaseBackupIcon}
          tone={o.lastSuccess ? (o.lastSuccess.verificationStatus === "VERIFIED" ? "success" : "warning") : "default"}
          value={o.lastSuccess ? relativeTime(o.lastSuccess.finishedAt) : "Never"}
          hint={o.lastSuccess ? <span className="inline-flex flex-wrap items-center gap-1.5"><Link className="font-mono hover:underline" href={`/salesforce/backups/${o.lastSuccess.id}`}>{o.lastSuccess.code}</Link><VerificationBadge status={o.lastSuccess.verificationStatus} /></span> : "No completed backup"}
          href={o.lastSuccess ? `/salesforce/backups/${o.lastSuccess.id}` : undefined}
        />
        <KpiCard label="Verified datasets" icon={BadgeCheckIcon} tone="brand" value={`${fmt.format(o.verification.VERIFIED ?? 0)} / ${fmt.format(totalDatasets)}`} hint={`${fmt.format(o.verification.PARTIALLY_VERIFIED ?? 0)} partially (limited) · ${fmt.format(gaps)} with gaps`} href="/salesforce/verification" />
        <KpiCard label="Recipient-level events" icon={UserSearchIcon} value={fmt.format(o.counts.trackingEvents)} hint={`${fmt.format(o.counts.emailJobs)} send jobs · ${fmt.format(o.counts.subscribers)} subscriber rows`} href="/salesforce/tracking" />
        <KpiCard label="Archive storage" icon={HardDriveIcon} value={formatBytes(o.storageBytes)} hint={`${fmt.format(o.counts.deRows)} DE rows across ${fmt.format(o.counts.dataExtensions)} Data Extensions`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <ChartCard
          className="xl:col-span-2"
          title="Archived tracking events by month (IST)"
          description="Counts of archived event rows. Months outside the extracted coverage are absent, not zero."
          empty={!months.length}
          table={{ rows: months, columns: [{ key: "month", label: "Month" }, ...["SENT", "OPEN", "CLICK", "BOUNCE", "UNSUB", "NOTSENT"].map((k) => ({ key: k, label: k, numeric: true }))] }}
        >
          <TrendChart
            data={months}
            xKey="month"
            series={[
              { key: "SENT", label: "Sent", color: "var(--viz-1)" },
              { key: "OPEN", label: "Opens", color: "var(--viz-3)" },
              { key: "CLICK", label: "Clicks", color: "var(--viz-2)" },
            ]}
          />
        </ChartCard>
        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Verification status</CardTitle>
            <CardDescription className="text-xs">Current datasets. The whole backup is never “verified” while gaps remain.</CardDescription>
          </CardHeader>
          <CardContent>
            {totalDatasets ? (
              <HBarList items={VERIFY_ORDER.filter((k) => o.verification[k]).map((k) => ({ label: k.replace(/_/g, " ").toLowerCase(), value: o.verification[k] ?? 0, color: VERIFY_COLOR[k], swatch: VERIFY_COLOR[k] }))} />
            ) : (
              <EmptyState compact title="Nothing archived yet" />
            )}
          </CardContent>
        </Card>
      </div>

      <section>
        <SectionTitle
          title="Tracking coverage by source"
          description={`SOAP tracking retention configured as ${coverage.retention.soapTracking.days ?? "unknown"} days (${coverage.retention.soapTracking.confirmed ? "confirmed" : "UNCONFIRMED — verify with Salesforce"}). Jobs without data are shown as not retrievable / not accessible, never as zero events.`}
          actions={<Button asChild variant="ghost" size="sm"><Link href="/salesforce/tracking">Open recipient tracking</Link></Button>}
        />
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Event source (SOAP)</TableHead>
                  <TableHead className="text-right">Jobs extracted</TableHead>
                  <TableHead className="text-right">Verified</TableHead>
                  <TableHead className="text-right">Not retrievable</TableHead>
                  <TableHead className="text-right">Not accessible / failed</TableHead>
                  <TableHead className="text-right">Not yet archived</TableHead>
                  <TableHead>Observed event window</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {coverage.byType.map((c) => (
                  <TableRow key={c.kind}>
                    <TableCell className="font-medium">{c.eventType === "NOTSENT" ? "NotSentEvent" : `${c.eventType.charAt(0)}${c.eventType.slice(1).toLowerCase()}Event`}</TableCell>
                    <TableCell className="tabular text-right">{fmt.format(c.jobsExtracted)}</TableCell>
                    <TableCell className="tabular text-right">{fmt.format(c.verified)}</TableCell>
                    <TableCell className="tabular text-right">{c.jobsNotRetrievable ? <span className="text-muted-foreground">{fmt.format(c.jobsNotRetrievable)}</span> : "—"}</TableCell>
                    <TableCell className="tabular text-right">{c.jobsNotAccessible + c.jobsFailed ? <span className="text-destructive">{fmt.format(c.jobsNotAccessible + c.jobsFailed)}</span> : "—"}</TableCell>
                    <TableCell className="tabular text-right">{c.jobsNotArchived ? fmt.format(c.jobsNotArchived) : "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{c.observedFrom ? `${formatIST(c.observedFrom, "dd MMM yyyy")} → ${formatIST(c.observedTo, "dd MMM yyyy")}` : "No events archived"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </section>

      <section>
        <SectionTitle title="Recent backups" actions={<Button asChild variant="ghost" size="sm"><Link href="/salesforce/backups">All backups</Link></Button>} />
        {o.lastJobs.length ? (
          <div className="overflow-hidden rounded-xl border bg-card">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Backup</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Verification</TableHead>
                  <TableHead>Started (IST)</TableHead>
                  <TableHead className="text-right">Records</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {o.lastJobs.map((j) => (
                  <TableRow key={j.id}>
                    <TableCell>
                      <Link href={`/salesforce/backups/${j.id}`} className="font-mono text-[13px] font-medium hover:underline">{j.code}</Link>
                      {j.isSimulated && <SimulatedBadge className="ml-2" />}
                      <p className="text-xs text-muted-foreground">{j.mode.toLowerCase()} · MID {j.mids.join(", ")}</p>
                    </TableCell>
                    <TableCell><JobStatusBadge status={j.status} /></TableCell>
                    <TableCell>{["COMPLETED", "COMPLETED_WITH_GAPS", "FAILED", "CANCELLED"].includes(j.status) ? <VerificationBadge status={j.verificationStatus} /> : <span className="text-xs text-muted-foreground">pending</span>}</TableCell>
                    <TableCell className="tabular text-xs text-muted-foreground">{formatIST(j.startedAt ?? j.createdAt)}</TableCell>
                    <TableCell className="tabular text-right">{(j.stats as { records?: number }).records !== undefined ? fmt.format((j.stats as { records: number }).records) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState compact icon={MailSearchIcon} title="No backups yet" description="Start with a full backup of metadata, Data Extensions, send jobs and recipient-level tracking." />
        )}
      </section>
    </div>
  );
}
