import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon, CopyIcon, FlaskConicalIcon, MailIcon, PhoneIcon, ShieldOffIcon, HistoryIcon, MessageSquareIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { getClientProfile } from "@/lib/services/clients";
import { listCategories } from "@/lib/services/categories";
import { PageHeader } from "@/components/app/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryChip, ChannelBadge, DeliveryStatusBadge, Pill } from "@/components/app/status";
import { EmptyState, Notice } from "@/components/app/empty-state";
import { Button } from "@/components/ui/button";
import { formatIST, formatDateIST } from "@/lib/time";
import { formatPhoneInternational } from "@/lib/phone";
import { hasPermission } from "@/lib/auth/permissions";
import { ClientActions } from "./client-actions";

export async function generateMetadata({ params }: PageProps<"/clients/[id]">) {
  if (!(await getCurrentUser())) return { title: "Sign in" };
  const { id } = await params;
  const r = await prisma.client.findUnique({ where: { id }, select: { fullName: true } });
  return { title: r?.fullName ?? "Not found" };
}

export default async function ClientProfilePage({ params }: PageProps<"/clients/[id]">) {
  const user = await requirePageUser("clients:read");
  const { id } = await params;
  const [c, categories] = await Promise.all([getClientProfile(id), listCategories()]);
  if (!c) notFound();
  const active = c.memberships.filter((m) => !m.removedAt && !m.category.archivedAt);
  const latest = (ch: "EMAIL" | "WHATSAPP") => c.consents.find((x) => x.channel === ch);
  const activeSuppressions = c.identifierSuppressions.filter((s) => !s.liftedAt);
  const crmFields = (c.crmFields ?? {}) as Record<string, unknown>;

  return (
    <div className="animate-in-fade space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
        <Link href="/clients">
          <ArrowLeftIcon /> Clients
        </Link>
      </Button>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {c.fullName}
            {c.isMock && (
              <Pill tone="warning">
                <FlaskConicalIcon className="size-3" /> Mock record
              </Pill>
            )}
          </span>
        }
        description={
          <span className="font-mono text-xs">
            Zoho CRM {c.crmModule} · {c.zohoCrmId}
          </span>
        }
        actions={
          hasPermission(user.role, "clients:write") && (
            <ClientActions
              clientId={c.id}
              email={c.emailNormalized}
              phone={c.phoneE164}
              categories={categories.map((x) => ({ id: x.id, name: x.name, color: x.color }))}
              memberCategoryIds={active.map((m) => m.categoryId)}
              canSuppress={hasPermission(user.role, "suppression:write")}
            />
          )
        }
      />

      {c.deletedInCrmAt && <Notice tone="danger" title="Deleted in Zoho CRM">This record was deleted in CRM on {formatIST(c.deletedInCrmAt)}. It is excluded from all campaigns; history is retained.</Notice>}
      {(c.duplicateOf || c.duplicates.length > 0 || c.possibleDuplicates.length > 0) && (
        <Notice tone="warning" icon={CopyIcon} title="Duplicate identity detected">
          {c.duplicateOf && (
            <>
              Shares an email with{" "}
              <Link className="underline" href={`/clients/${c.duplicateOf.id}`}>
                {c.duplicateOf.fullName}
              </Link>{" "}
              ({c.duplicateOf.zohoCrmId}), which is treated as the primary record. This record is excluded from campaigns.{" "}
            </>
          )}
          {c.duplicates.length > 0 && <>Primary record for {c.duplicates.length} duplicate CRM record(s). </>}
          {c.possibleDuplicates.length > 0 && <>{c.possibleDuplicates.length} other record(s) share this phone number — each campaign sends at most one message per number. </>}
          Merge duplicates in Zoho CRM to resolve permanently.
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Contact (from CRM)</CardTitle>
            <CardDescription className="text-xs">Read-only — edit in Zoho CRM.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row icon={MailIcon} label="Email">
              {c.email ? <span className={c.emailNormalized ? "" : "text-destructive"}>{c.email}</span> : <span className="text-muted-foreground">Missing</span>}
            </Row>
            <Row icon={PhoneIcon} label="Mobile">
              {c.phoneValid ? (
                <>
                  {formatPhoneInternational(c.phoneE164)}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {c.phoneCountry} (+{c.phoneCountryCode})
                  </span>
                </>
              ) : c.phoneRaw ? (
                <span className="text-destructive">{c.phoneRaw} — invalid</span>
              ) : (
                <span className="text-muted-foreground">Missing</span>
              )}
            </Row>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-3 text-xs">
              <Meta label="CRM status">{c.crmStatus ?? "—"}</Meta>
              <Meta label="Owner">{c.crmOwner ?? "—"}</Meta>
              <Meta label="City">{c.city ?? "—"}</Meta>
              <Meta label="CRM modified">{formatDateIST(c.crmModifiedAt)}</Meta>
              <Meta label="Last synced">{formatIST(c.lastSyncedAt)}</Meta>
              <Meta label="CRM email opt-out">{c.crmEmailOptOut ? "Yes" : "No"}</Meta>
              {Object.entries(crmFields).map(([k, v]) => (
                <Meta key={k} label={k.replace(/_/g, " ")}>
                  {typeof v === "object" ? JSON.stringify(v) : String(v ?? "—")}
                </Meta>
              ))}
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Categories</CardTitle>
            <CardDescription className="text-xs">{active.length} active membership{active.length === 1 ? "" : "s"} · managed in this dashboard</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {active.length ? (
              <ul className="space-y-2">
                {active.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 text-sm">
                    <Link href={`/categories/${m.categoryId}`}>
                      <CategoryChip name={m.category.name} color={m.category.color} />
                    </Link>
                    <span className="text-xs text-muted-foreground">
                      {m.source.toLowerCase()} · {formatDateIST(m.addedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Not in any category.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Consent & suppression</CardTitle>
            <CardDescription className="text-xs">Latest decision per channel. Full history below.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {(["EMAIL", "WHATSAPP"] as const).map((ch) => {
              const l = latest(ch);
              const optOut = ch === "EMAIL" && c.crmEmailOptOut;
              return (
                <div key={ch} className="flex items-start justify-between gap-2">
                  <ChannelBadge channel={ch} />
                  <div className="text-right">
                    {optOut ? <Pill tone="warning">Opted out (CRM)</Pill> : l ? <Pill tone={l.status === "GRANTED" ? "success" : "warning"}>{l.status === "GRANTED" ? "Consent granted" : "Consent revoked"}</Pill> : <Pill tone="muted">No record</Pill>}
                    {l && <p className="mt-1 text-xs text-muted-foreground">{formatDateIST(l.effectiveAt)} · {l.source.toLowerCase().replace("_", " ")}</p>}
                  </div>
                </div>
              );
            })}
            <div className="border-t pt-3">
              {activeSuppressions.length ? (
                <ul className="space-y-1.5">
                  {activeSuppressions.map((s) => (
                    <li key={s.id} className="flex items-center gap-2 text-xs">
                      <ShieldOffIcon className="size-3.5 text-destructive" />
                      <span>
                        Suppressed {s.channel ? s.channel.toLowerCase() : "all channels"} — {s.reason.toLowerCase().replace("_", " ")}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">Not on any suppression list.</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Communication history</CardTitle>
          <CardDescription className="text-xs">Every message prepared for this client, with provider events.</CardDescription>
        </CardHeader>
        <CardContent>
          {c.deliveries.length ? (
            <ul className="divide-y">
              {c.deliveries.map((d) => (
                <li key={d.id} className="grid gap-2 py-3 first:pt-0 md:grid-cols-[1fr_auto]">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <ChannelBadge channel={d.channel} />
                      <Link href={`/campaigns/${d.campaign.id}`} className="truncate text-sm font-medium hover:underline">
                        {d.campaign.name}
                      </Link>
                      <CategoryChip name={d.assignment.category.name} color={d.assignment.category.color} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Template “{d.assignment.template.name}” · created {formatIST(d.createdAt)}
                      {d.providerMessageId && <span className="ml-1 font-mono">· {d.providerMessageId.slice(0, 18)}</span>}
                    </p>
                    {d.failureReason && <p className="text-xs text-destructive">{d.failureReason}</p>}
                    <ol className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                      {d.events.map((e) => (
                        <li key={e.id}>
                          {e.toStatus.toLowerCase()} · {formatIST(e.occurredAt, "dd MMM, HH:mm")} · {e.source.toLowerCase().replace("_", " ")}
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div className="md:text-right">
                    <DeliveryStatusBadge status={d.status} simulated={d.isSimulated} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact icon={MessageSquareIcon} title="No communications yet" />
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Membership history</CardTitle>
          </CardHeader>
          <CardContent>
            {c.membershipEvents.length ? (
              <ul className="space-y-2 text-sm">
                {c.membershipEvents.map((e) => (
                  <li key={e.id} className="flex flex-wrap items-center gap-2">
                    <Pill tone={e.action === "ADDED" ? "success" : "muted"}>{e.action === "ADDED" ? "Added" : "Removed"}</Pill>
                    <CategoryChip name={e.category.name} color={e.category.color} />
                    <span className="text-xs text-muted-foreground">
                      {e.source.toLowerCase()} · {e.actor?.name ?? "system"} · {formatIST(e.createdAt)}
                      {e.note && ` · ${e.note}`}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact icon={HistoryIcon} title="No membership changes" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Consent history</CardTitle>
          </CardHeader>
          <CardContent>
            {c.consents.length ? (
              <ul className="space-y-2 text-sm">
                {c.consents.map((x) => (
                  <li key={x.id} className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <ChannelBadge channel={x.channel} />
                      <Pill tone={x.status === "GRANTED" ? "success" : "warning"}>{x.status.toLowerCase()}</Pill>
                      <span className="text-xs text-muted-foreground">{formatIST(x.effectiveAt)}</span>
                    </div>
                    {x.evidence && <p className="text-xs text-muted-foreground">{x.evidence}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact title="No consent records" />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Row({ icon: Icon, label, children }: { icon: React.ComponentType<{ className?: string }>; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="mt-0.5 size-4 text-muted-foreground" />
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="break-all">{children}</p>
      </div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="capitalize text-muted-foreground">{label}</dt>
      <dd className="truncate">{children}</dd>
    </div>
  );
}
