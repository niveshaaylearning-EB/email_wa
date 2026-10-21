import Link from "next/link";
import { CircleDashedIcon, CircleHelpIcon, CircleSlashIcon, LockIcon, SearchIcon, UserSearchIcon } from "lucide-react";
import type { SfTrackingEventType } from "@prisma/client";
import { requirePageUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { requestMeta } from "@/lib/auth/session";
import { searchTracking, subscriberTimeline, type TimelineJob } from "@/lib/services/salesforce/queries";
import { archiveAudit } from "@/lib/services/salesforce/audit";
import { PageHeader, SectionTitle } from "@/components/app/page-header";
import { EmptyState, Notice } from "@/components/app/empty-state";
import { UrlPagination } from "@/components/app/url-controls";
import { Pill } from "@/components/app/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExportButton } from "@/components/salesforce/export-button";
import { EventTypeBadge, fmt } from "@/components/salesforce/status";
import { formatIST, istLocalToUtc } from "@/lib/time";
import { cn } from "@/lib/utils";

export const metadata = { title: "Recipient tracking" };

const TYPES = ["SENT", "NOTSENT", "BOUNCE", "OPEN", "CLICK", "UNSUB"] as const;
const TYPE_LABEL: Record<string, string> = { SENT: "Send", NOTSENT: "Not sent", BOUNCE: "Bounce", OPEN: "Open", CLICK: "Click", UNSUB: "Unsubscribe" };

function StateCell({ s }: { s: TimelineJob["states"][string] }) {
  if (s.status === "OBSERVED") {
    const first = s.events[0];
    return (
      <div className="rounded-md border border-primary/25 bg-primary/5 px-2 py-1.5">
        <p className="text-xs font-semibold text-primary">{s.events.length > 1 ? `${s.events.length}×` : "Observed"}</p>
        <p className="tabular text-[11px] text-muted-foreground" title={`raw: ${first.raw ?? "—"}`}>{formatIST(first.date, "dd MMM yy, hh:mm a")}</p>
        {first.detail && <p className="truncate text-[11px] text-muted-foreground" title={first.detail}>{first.detail}</p>}
      </div>
    );
  }
  const map = {
    NOT_OBSERVED: { icon: CircleDashedIcon, label: "None observed", cls: "text-muted-foreground", title: "Tracking for this job was archived and contains no such event for this subscriber." },
    NOT_RETRIEVABLE: { icon: CircleSlashIcon, label: "Not retrievable", cls: "text-muted-foreground", title: "Outside the source's retention window — unknown, not zero." },
    NOT_ACCESSIBLE: { icon: LockIcon, label: "Not accessible", cls: "text-destructive", title: "The API user could not read this tracking object." },
    NOT_ARCHIVED: { icon: CircleHelpIcon, label: "Unknown", cls: "text-warning", title: "This tracking type has not been archived for this job." },
  } as const;
  const m = map[s.status as keyof typeof map];
  return (
    <div title={m.title} className={cn("flex items-center gap-1.5 rounded-md border border-dashed px-2 py-1.5 text-[11px]", m.cls)}>
      <m.icon className="size-3.5" /> {m.label}
    </div>
  );
}

export default async function TrackingPage({ searchParams }: PageProps<"/salesforce/tracking">) {
  const user = await requirePageUser("archive:read");
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" && sp[k] ? (sp[k] as string).trim() : undefined);
  const subscriberKey = str("subscriberKey");
  const jobId = str("jobId");
  const eventType = TYPES.includes(str("eventType") as never) ? (str("eventType") as SfTrackingEventType) : undefined;
  const from = str("from");
  const to = str("to");
  const page = Math.max(1, Number(sp.page) || 1);
  const tpage = Math.max(1, Number(sp.tpage) || 1);
  const TPAGE = 50;
  const hasQuery = !!(subscriberKey || jobId || eventType || from || to);
  const [timeline, events] = await Promise.all([
    subscriberKey ? subscriberTimeline(subscriberKey) : null,
    hasQuery ? searchTracking({ subscriberKey, jobId, eventType, from: from ? istLocalToUtc(`${from}T00:00`) : undefined, to: to ? istLocalToUtc(`${to}T23:59`) : undefined, page, pageSize: 100 }) : null,
  ]);
  if (subscriberKey) await archiveAudit({ actor: user, action: "archive.view.subscriber", entityType: "salesforce_subscriber", entityId: subscriberKey, metadata: { jobId: jobId ?? null }, ...(await requestMeta()) });
  const canExport = hasPermission(user.role, "archive:export");

  return (
    <div className="animate-in-fade space-y-6">
      <PageHeader title="Recipient tracking" description="Every archived event is stored individually — repeated opens and clicks are never collapsed. Searches by client are recorded in the archive audit log." />
      <form method="get" className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-3">
        <label className="text-xs text-muted-foreground">
          Subscriber key
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input name="subscriberKey" defaultValue={subscriberKey} placeholder="exact SubscriberKey" className="h-9 w-64 pl-8" />
          </div>
        </label>
        <label className="text-xs text-muted-foreground">
          JobID
          <Input name="jobId" defaultValue={jobId} inputMode="numeric" className="h-9 w-32" />
        </label>
        <label className="text-xs text-muted-foreground">
          Event
          <select name="eventType" defaultValue={eventType ?? ""} className="block h-9 rounded-md border bg-background px-2 text-sm">
            <option value="">All</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>{TYPE_LABEL[t]}</option>
            ))}
          </select>
        </label>
        <label className="text-xs text-muted-foreground">
          From
          <Input type="date" name="from" defaultValue={from} className="h-9 w-40" />
        </label>
        <label className="text-xs text-muted-foreground">
          To
          <Input type="date" name="to" defaultValue={to} className="h-9 w-40" />
        </label>
        <Button type="submit" size="sm">Search</Button>
        {hasQuery && <Button asChild size="sm" variant="ghost"><Link href="/salesforce/tracking">Clear</Link></Button>}
        {canExport && hasQuery && <span className="ml-auto"><ExportButton spec={{ type: "tracking", ...(subscriberKey ? { subscriberKey } : {}), ...(jobId ? { jobId } : {}), ...(eventType ? { eventType } : {}), ...(from ? { from: istLocalToUtc(`${from}T00:00`).toISOString() } : {}), ...(to ? { to: istLocalToUtc(`${to}T23:59`).toISOString() } : {}) }} label="Export results" /></span>}
      </form>

      {!hasQuery && <EmptyState icon={UserSearchIcon} title="Search recipient-level evidence" description="Enter a SubscriberKey to see that client's full timeline across campaigns, or a JobID to list every recipient event of a send." />}

      {timeline && (
        <section className="space-y-4">
          <SectionTitle title={`Timeline · ${subscriberKey}`} description={`${fmt.format(timeline.eventCount)} archived event(s) across ${timeline.timeline.length} send job(s). Unknown and unavailable states are shown explicitly.`} />
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border bg-card p-4 text-sm">
              <p className="mb-2 font-medium">Subscriber record (archived)</p>
              {timeline.subscriber ? (
                <dl className="space-y-1">
                  <div className="flex justify-between"><dt className="text-muted-foreground">Status at extraction</dt><dd><Pill tone={timeline.subscriber.status === "Active" ? "success" : "warning"}>{timeline.subscriber.status ?? "—"}</Pill></dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">Email</dt><dd className="font-mono text-xs">{timeline.subscriber.emailAddress ?? "—"}</dd></div>
                  <div className="flex justify-between"><dt className="text-muted-foreground">Created / unsubscribed (source)</dt><dd className="text-xs">{timeline.subscriber.createdDate ?? "—"} / {timeline.subscriber.unsubscribedDate || "—"}</dd></div>
                </dl>
              ) : (
                <p className="text-xs text-muted-foreground">Not found in the archived subscriber list (or subscribers were not archived).</p>
              )}
            </div>
            <div className="rounded-xl border bg-card p-4 text-sm">
              <p className="mb-2 font-medium">Audience membership (archived snapshots)</p>
              {timeline.memberships.length ? (
                <ul className="space-y-1 text-xs">
                  {timeline.memberships.slice(0, 15).map((m) => (
                    <li key={m.datasetId} className="flex justify-between gap-3"><span className="truncate">{m.label}</span><span className="shrink-0 text-muted-foreground">snapshot {formatIST(m.extractedAt, "dd MMM yyyy")}{m.rows > 1 ? ` · ${m.rows} rows` : ""}</span></li>
                  ))}
                  {timeline.memberships.length > 15 && <li className="text-muted-foreground">… and {fmt.format(timeline.memberships.length - 15)} more list(s)</li>}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">Not present in any archived Data Extension snapshot (matched on SubscriberKey / ContactKey columns).</p>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">Snapshots show membership when extracted — not proof of membership at a past send time.</p>
            </div>
          </div>
          {timeline.timeline.length ? (
            <div className="overflow-hidden rounded-xl border bg-card">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead className="min-w-56">Send job</TableHead>
                      {TYPES.map((t) => (
                        <TableHead key={t} className="min-w-32">{TYPE_LABEL[t]}</TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {timeline.timeline.slice((tpage - 1) * TPAGE, tpage * TPAGE).map((j) => (
                      <TableRow key={`${j.mid}-${j.jobId}`} className="align-top">
                        <TableCell>
                          <Link href={`/salesforce/campaigns/${j.mid}/${j.jobId}`} className="font-medium hover:underline">{j.emailName ?? `Job ${j.jobId}`}</Link>
                          <p className="text-xs text-muted-foreground"><span className="font-mono">{j.jobId}</span> · {formatIST(j.sendDate, "dd MMM yyyy")}</p>
                        </TableCell>
                        {TYPES.map((t) => (
                          <TableCell key={t}><StateCell s={j.states[t]} /></TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {timeline.timeline.length > TPAGE && (
                <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-muted-foreground">
                  <span className="tabular">Sends {fmt.format((tpage - 1) * TPAGE + 1)}–{fmt.format(Math.min(tpage * TPAGE, timeline.timeline.length))} of {fmt.format(timeline.timeline.length)}</span>
                  <span className="flex gap-2">
                    {tpage > 1 && <Link className="text-primary hover:underline" href={`?subscriberKey=${encodeURIComponent(subscriberKey!)}&tpage=${tpage - 1}`}>← Newer</Link>}
                    {tpage * TPAGE < timeline.timeline.length && <Link className="text-primary hover:underline" href={`?subscriberKey=${encodeURIComponent(subscriberKey!)}&tpage=${tpage + 1}`}>Older →</Link>}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <Notice tone="info" title="No archived events for this SubscriberKey">This means none were found in the archived tracking datasets — check coverage on the Archive Overview before concluding no communication occurred.</Notice>
          )}
        </section>
      )}

      {events && (
        <section>
          <SectionTitle title="Events" description={`${fmt.format(events.total)} matching event row(s), newest first.`} />
          {events.rows.length ? (
            <div className="overflow-hidden rounded-xl border bg-card">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>Event</TableHead>
                      <TableHead>Event time (IST)</TableHead>
                      <TableHead>Raw source time</TableHead>
                      <TableHead>SubscriberKey</TableHead>
                      <TableHead>JobID</TableHead>
                      <TableHead>Batch · List</TableHead>
                      <TableHead>Detail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.rows.map((e) => (
                      <TableRow key={String(e.id)}>
                        <TableCell><EventTypeBadge type={e.eventType} /></TableCell>
                        <TableCell className="tabular whitespace-nowrap text-xs">{formatIST(e.eventDate, "dd MMM yyyy, hh:mm:ss a")}</TableCell>
                        <TableCell className="font-mono text-[11px] text-muted-foreground">{e.eventDateRaw}</TableCell>
                        <TableCell><Link className="font-mono text-xs hover:underline" href={`/salesforce/tracking?subscriberKey=${encodeURIComponent(e.subscriberKey ?? "")}`}>{e.subscriberKey}</Link></TableCell>
                        <TableCell className="font-mono text-xs">{e.jobId}</TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{e.batchId ?? "—"} · {e.listId ?? "—"}</TableCell>
                        <TableCell className="max-w-[260px] truncate text-xs" title={e.url ?? e.smtpReason ?? e.sourceEventType ?? ""}>{e.url ?? (e.bounceCategory ? `${e.bounceCategory} ${e.smtpCode ?? ""}` : e.sourceEventType)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="border-t px-3"><UrlPagination total={events.total} page={page} pageSize={100} /></div>
            </div>
          ) : (
            <EmptyState compact title="No matching archived events" description="Absence from the archive is not proof that no event occurred — check tracking coverage for the period." />
          )}
        </section>
      )}
    </div>
  );
}
