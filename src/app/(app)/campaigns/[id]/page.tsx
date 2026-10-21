import { getCurrentUser } from "@/lib/auth/session";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon, FlaskConicalIcon, LockIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { getCampaignAnalytics } from "@/lib/services/analytics";
import { previewCampaignAudience } from "@/lib/services/campaigns";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CampaignStatusBadge, CategoryChip, ChannelBadge, Pill } from "@/components/app/status";
import { Notice } from "@/components/app/empty-state";
import { hasPermission } from "@/lib/auth/permissions";
import { formatIST } from "@/lib/time";
import { EXCLUSION_LABELS } from "@/lib/domain/labels";
import type { ExclusionReasonKey } from "@/lib/domain/eligibility";
import { CampaignActions } from "./campaign-actions";
import { ApprovalPanel } from "./approval-panel";
import { ExecutionProgress } from "./execution-progress";
import { RecipientTable } from "./recipient-table";
import { Funnel } from "@/components/charts/charts";
import { FAILURE_EXPLANATIONS } from "./failure-explanations";
import { loadIntegration } from "@/lib/services/integrations";
import { env } from "@/lib/env";

const nf = (n: number) => n.toLocaleString("en-IN");

export async function generateMetadata({ params }: PageProps<"/campaigns/[id]">) {
  if (!(await getCurrentUser())) return { title: "Sign in" };
  const { id } = await params;
  const r = await prisma.campaign.findUnique({ where: { id }, select: { name: true } });
  return { title: r?.name ?? "Not found" };
}

export default async function CampaignDetailPage({ params }: PageProps<"/campaigns/[id]">) {
  const user = await requirePageUser("campaigns:read");
  const { id } = await params;
  const a = await getCampaignAnalytics(id);
  if (!a || a.campaign.deletedAt) notFound();
  const c = a.campaign;
  const [people, audits, templates] = await Promise.all([
    prisma.user.findMany({ where: { id: { in: [c.createdById, c.submittedById, c.approvedById, c.rejectedById, c.cancelledById].filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    prisma.auditLog.findMany({ where: { campaignId: id }, orderBy: { createdAt: "desc" }, take: 60 }),
    prisma.template.findMany({ where: { id: { in: c.categories.flatMap((x) => [x.emailTemplateId, x.whatsappTemplateId]).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
  ]);
  const name = (uid?: string | null) => people.find((p) => p.id === uid)?.name ?? "—";
  const tname = (tid?: string | null) => templates.find((t) => t.id === tid)?.name ?? "—";
  const isApprover = hasPermission(user.role, "campaigns:approve");
  const pending = c.status === "PENDING_APPROVAL";
  const preview = pending || ["DRAFT", "REJECTED"].includes(c.status) ? await previewCampaignAudience(id, { sampleSize: 50 }) : null;
  const channels = c.channelMode === "BOTH" ? (["EMAIL", "WHATSAPP"] as const) : ([c.channelMode] as const);
  const liveModes = await Promise.all(channels.map(async (ch) => (await loadIntegration(ch === "EMAIL" ? "ZOHO_MA" : "DOUBLETICK")).mode));
  const wouldBeLive = env().ALLOW_LIVE_SEND && liveModes.includes("LIVE");
  const snap = c.snapshot;
  const f = a.funnel;
  const simulated = a.counts.simulated > 0;

  return (
    <div className="animate-in-fade space-y-5">
      <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
        <Link href="/campaigns">
          <ArrowLeftIcon /> Campaign Studio
        </Link>
      </Button>
      <PageHeader
        title={c.name}
        eyebrow={
          <span className="flex flex-wrap items-center gap-2">
            <CampaignStatusBadge status={c.status} />
            <ChannelBadge channel={c.channelMode} />
            {c.approvedAt && (c.isLive ? <Pill tone="danger">Live</Pill> : <Pill tone="info">Non-live (mock / dry-run)</Pill>)}
          </span>
        }
        description={c.description || undefined}
        actions={
          <CampaignActions
            id={c.id}
            status={c.status}
            canWrite={hasPermission(user.role, "campaigns:write")}
            canExecute={hasPermission(user.role, "campaigns:execute")}
            isCreator={c.createdById === user.id}
            hasReport={!!snap && hasPermission(user.role, "analytics:read")}
          />
        }
      />

      {c.status === "REJECTED" && <Notice tone="danger" title={`Rejected by ${name(c.rejectedById)}`}>{c.rejectionReason}</Notice>}
      {c.status === "PAUSED" && c.failureReason && <Notice tone="warning" title="Paused">{c.failureReason}</Notice>}
      {simulated && (
        <Notice tone="warning" icon={FlaskConicalIcon} title="Simulated execution">
          This campaign ran against MOCK provider adapters. Delivery events below were generated by the simulator and are marked “sim” — no real messages were sent.
        </Notice>
      )}
      {f.dryRun > 0 && <Notice tone="info" title="Dry run">{nf(f.dryRun)} messages were rendered and recorded in DRY-RUN mode. No provider send endpoints were called.</Notice>}

      {pending && preview && (
        <ApprovalPanel
          campaignId={c.id}
          canApprove={isApprover && c.createdById !== user.id && c.submittedById !== user.id}
          isOwn={c.createdById === user.id || c.submittedById === user.id}
          isApprover={isApprover}
          summary={preview.summary}
          validation={preview.validation}
          wouldBeLive={wouldBeLive}
        />
      )}

      {["QUEUED", "RUNNING", "PAUSED", "COMPLETED", "CANCELLED", "FAILED"].includes(c.status) && <ExecutionProgress campaignId={c.id} status={c.status} counts={a.counts} planned={f.plannedMessages} />}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Delivery funnel</CardTitle>
            <CardDescription className="text-xs">Provider acceptance is shown separately from delivery. Email per-recipient delivery isn’t reported by Zoho — email shows sent, opened and clicked.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 md:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-medium text-muted-foreground">Audience</p>
              <Funnel
                stages={[
                  { label: "Intended (category members)", value: snap ? f.intended : preview?.summary.uniqueClients ?? null },
                  { label: "Eligible recipients", value: snap ? f.eligible : preview?.summary.eligibleRecipients ?? null },
                  { label: "Planned messages (all channels)", value: snap ? f.plannedMessages : preview?.summary.messageVolume ?? null, noPct: true },
                ]}
              />
            </div>
            <div className="space-y-4">
              {channels.includes("WHATSAPP" as never) && (
                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">WhatsApp</p>
                  <Funnel
                    stages={[
                      { label: "Submitted", value: a.counts.WHATSAPP.submitted },
                      { label: "Provider accepted", value: a.counts.WHATSAPP.accepted },
                      { label: "Delivered", value: a.counts.WHATSAPP.delivered },
                      { label: "Read", value: a.counts.WHATSAPP.read },
                    ]}
                  />
                </div>
              )}
              {channels.includes("EMAIL" as never) && (
                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Email</p>
                  <Funnel
                    stages={[
                      { label: "Submitted", value: a.counts.EMAIL.submitted },
                      { label: "Accepted by Zoho", value: a.counts.EMAIL.accepted },
                      { label: "Sent (reported)", value: a.counts.EMAIL.sent },
                      { label: "Opened", value: a.counts.EMAIL.opened },
                      { label: "Clicked", value: a.counts.EMAIL.clicked },
                    ]}
                  />
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Approval record</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row k="Created by" v={`${name(c.createdById)} · ${formatIST(c.createdAt)}`} />
            <Row k="Submitted" v={c.submittedAt ? `${name(c.submittedById)} · ${formatIST(c.submittedAt)}` : "—"} />
            <Row k="Approved" v={c.approvedAt ? `${name(c.approvedById)} · ${formatIST(c.approvedAt)}` : "—"} />
            {c.approvalNote && <Row k="Approval note" v={c.approvalNote} />}
            <Row k="Schedule" v={c.scheduledAt ? `${formatIST(c.scheduledAt)} IST` : "Immediately after approval"} />
            <Row k="Started" v={formatIST(c.startedAt)} />
            <Row k="Completed" v={formatIST(c.completedAt)} />
            {c.cancelledAt && <Row k="Cancelled" v={`${name(c.cancelledById)} · ${formatIST(c.cancelledAt)} — ${c.failureReason ?? ""}`} />}
            {snap && (
              <div className="mt-3 flex items-start gap-2 rounded-lg bg-muted/60 p-2.5 text-xs text-muted-foreground">
                <LockIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Audience frozen {formatIST(snap.frozenAt)} · snapshot <span className="font-mono">{snap.contentHash.slice(0, 12)}</span>. Recipients, template versions and consent decisions can’t be changed.
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Categories & templates</CardTitle>
            <CardDescription className="text-xs">Overlap rule: {c.overlapStrategy.replace(/_/g, " ").toLowerCase()}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {c.categories
                .sort((x, y) => x.priority - y.priority)
                .map((cc) => {
                  const pc = a.perCategory.filter((p) => p.categoryId === cc.categoryId);
                  return (
                    <li key={cc.id} className="space-y-1 py-2.5 first:pt-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <span className="tabular text-xs text-muted-foreground">#{cc.priority}</span>
                          <CategoryChip name={cc.category.name} color={cc.category.color} />
                        </span>
                        <span className="tabular text-xs text-muted-foreground">{cc.memberCountAtSnapshot !== null ? `${nf(cc.memberCountAtSnapshot)} members at approval` : ""}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {cc.emailTemplateId && <>Email: {tname(cc.emailTemplateId)} </>}
                        {cc.whatsappTemplateId && <>WhatsApp: {tname(cc.whatsappTemplateId)}</>}
                      </p>
                      {pc.length > 0 && (
                        <p className="text-xs">
                          {pc.map((p) => `${p.channel === "EMAIL" ? "Email" : "WA"} ${nf(p.total)} msgs · ${nf(p.channel === "EMAIL" ? p.opened : p.delivered)} ${p.channel === "EMAIL" ? "opened" : "delivered"} · ${nf(p.failed)} failed`).join("  |  ")}
                        </p>
                      )}
                    </li>
                  );
                })}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Exclusions & failures</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Excluded at {snap ? "approval" : "preview"}</p>
              {(snap ? a.exclusions : Object.entries(preview?.summary.exclusionCounts ?? {}).map(([reason, count]) => ({ reason, count: count ?? 0 }))).length ? (
                <ul className="space-y-1 text-sm">
                  {(snap ? a.exclusions : Object.entries(preview?.summary.exclusionCounts ?? {}).map(([reason, count]) => ({ reason, count: count ?? 0 }))).map((e) => (
                    <li key={e.reason} className="flex justify-between">
                      <span>{EXCLUSION_LABELS[e.reason as ExclusionReasonKey] ?? e.reason}</span>
                      <span className="tabular">{nf(e.count)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">None.</p>
              )}
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Failures</p>
              {a.failures.length ? (
                <ul className="space-y-2 text-sm">
                  {a.failures.map((x) => (
                    <li key={x.code}>
                      <div className="flex justify-between">
                        <span className="font-mono text-xs">{x.code}</span>
                        <span className="tabular">{nf(x.count)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{FAILURE_EXPLANATIONS[x.code] ?? "Provider-reported failure — see per-recipient detail."}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No failures.</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {snap && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Reconciliation</CardTitle>
            <CardDescription className="text-xs">Frozen plan vs. created deliveries vs. provider records.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-3 text-sm">
              <Row k="Planned assignments" v={nf(a.reconciliation.plannedAssignments)} />
              <Row k="Deliveries created" v={nf(a.reconciliation.deliveriesCreated)} />
              <Row k="Missing" v={nf(a.reconciliation.missingDeliveries)} />
            </div>
            {a.reconciliation.emailGroups.length > 0 && (
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead className="bg-muted text-muted-foreground">
                    <tr>
                      <th className="px-3 py-1.5 text-left">Email group</th>
                      <th className="px-3 py-1.5 text-left">Status</th>
                      <th className="px-3 py-1.5 text-left">Zoho list / campaign</th>
                      <th className="px-3 py-1.5 text-right">Frozen</th>
                      <th className="px-3 py-1.5 text-right">Verified in list</th>
                      <th className="px-3 py-1.5 text-left">Provider report</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.reconciliation.emailGroups.map((g) => {
                      const r = g.providerReport as Record<string, unknown> | null;
                      return (
                        <tr key={g.index} className="border-t">
                          <td className="px-3 py-1.5">#{g.index + 1}</td>
                          <td className="px-3 py-1.5">{g.status}</td>
                          <td className="px-3 py-1.5 font-mono">{g.listKey ?? "—"} / {g.campaignKey ?? "—"}</td>
                          <td className="tabular px-3 py-1.5 text-right">{g.expected ?? "—"}</td>
                          <td className="tabular px-3 py-1.5 text-right">{g.verifiedCount ?? "—"}</td>
                          <td className="px-3 py-1.5">{r ? (r.simulated ? "simulated" : `sent ${r.sent ?? "?"} · delivered ${r.delivered ?? "?"} · opens ${r.opens ?? "?"} · bounces ${r.bounces ?? "?"}`) : "not yet"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {snap && <RecipientTable campaignId={c.id} />}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Activity</CardTitle>
          <CardDescription className="text-xs">Immutable audit trail for this campaign.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-2.5">
            {audits.map((l) => (
              <li key={l.id} className="grid grid-cols-[140px_1fr] gap-3 text-sm">
                <span className="tabular text-xs text-muted-foreground">{formatIST(l.createdAt, "dd MMM, hh:mm:ss a")}</span>
                <span>
                  <span className="font-medium">{l.action.replace("campaign.", "").replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground"> · {l.actorEmail}</span>
                </span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right">{v}</span>
    </div>
  );
}
