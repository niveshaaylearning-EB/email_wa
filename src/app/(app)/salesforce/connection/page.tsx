import { CheckCircle2Icon, CircleSlashIcon, ShieldCheckIcon, XCircleIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { hasPermission } from "@/lib/auth/permissions";
import { listConnections, simulatedAllowed } from "@/lib/services/salesforce/connections";
import { READ_SCOPES_RECOMMENDED } from "@/lib/salesforce/readonly";
import { CAPABILITY_PROBES } from "@/lib/salesforce/objects";
import { PageHeader } from "@/components/app/page-header";
import { Notice } from "@/components/app/empty-state";
import { Pill } from "@/components/app/status";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SimulatedBadge } from "@/components/salesforce/status";
import { formatIST, relativeTime } from "@/lib/time";
import { ConnectionForm } from "./connection-form";
import { BusinessUnits } from "./business-units";

export const metadata = { title: "Salesforce connection" };

const STATUS_TONE = { CONNECTED: "success", CONFIGURED: "info", ERROR: "danger", NOT_CONFIGURED: "muted" } as const;

export default async function ConnectionPage() {
  const user = await requirePageUser("archive:read");
  const canManage = hasPermission(user.role, "archive:manage");
  const connections = await listConnections();
  const c = connections[0] ?? null;

  return (
    <div className="animate-in-fade space-y-5">
      <PageHeader
        title="Salesforce connection"
        description="Official Marketing Cloud Engagement Installed Package API (server-to-server OAuth, client credentials). The archive only reads — it never creates, updates, deletes, sends, starts or stops anything in Salesforce."
      />
      <Notice tone="success" icon={ShieldCheckIcon} title="Read-only by construction">
        Every outgoing request passes an allow-list: OAuth token + userinfo, SOAP <code className="font-mono text-xs">Retrieve</code> only, and REST <code className="font-mono text-xs">GET</code> on journey and Content Builder resources. Anything else is rejected before it leaves this server. SFTP / Enhanced FTP is not used.
      </Notice>

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                {c ? c.name : "New connection"}
                {c && <Pill tone={STATUS_TONE[c.status]} dot>{c.status.replace("_", " ").toLowerCase()}</Pill>}
                {c?.kind === "SIMULATED" && <SimulatedBadge />}
              </CardTitle>
              <CardDescription className="text-xs">
                {c?.lastTestedAt ? `Last tested ${relativeTime(c.lastTestedAt)} (${formatIST(c.lastTestedAt)})` : "Not tested yet"}
                {c?.restBaseUri && <span className="block font-mono">REST {c.restBaseUri} · SOAP {c.soapBaseUri}</span>}
                {c?.enterpriseMid && <span className="block">Enterprise MID {c.enterpriseMid}{(c.accountInfo.memberId as string | null) ? ` · token MID ${c.accountInfo.memberId}` : ""}</span>}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {c?.lastError && c.status === "ERROR" && (
                <Notice tone="danger" className="mb-4" title="Last error">
                  {c.lastError}
                </Notice>
              )}
              <ConnectionForm connection={c} canManage={canManage} simulatedAllowed={simulatedAllowed()} />
            </CardContent>
          </Card>

          {c && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Read permissions (probe results)</CardTitle>
                <CardDescription className="text-xs">One minimal read per capability from the last test. “Denied” means the Installed Package lacks the scope or the API user lacks access in that BU.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="divide-y rounded-lg border">
                  {CAPABILITY_PROBES.map((p) => {
                    const r = c.capabilities[p.key];
                    return (
                      <li key={p.key} className="flex items-start gap-3 px-3 py-2.5 text-sm">
                        {!r ? <CircleSlashIcon className="mt-0.5 size-4 text-muted-foreground" /> : r.status === "ok" ? <CheckCircle2Icon className="mt-0.5 size-4 text-success" /> : <XCircleIcon className="mt-0.5 size-4 text-destructive" />}
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{p.label}</p>
                          {r?.message && <p className="text-xs text-muted-foreground">{r.message}</p>}
                        </div>
                        <code className="font-mono text-xs text-muted-foreground">{p.scope}</code>
                        <Pill tone={!r ? "muted" : r.status === "ok" ? "success" : r.status === "denied" ? "danger" : "warning"}>{r?.status ?? "untested"}</Pill>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          )}

          {c && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Business units</CardTitle>
                <CardDescription className="text-xs">Selected MIDs are pre-filled in the Backup Center. Each MID is extracted with its own BU-scoped token (account_id).</CardDescription>
              </CardHeader>
              <CardContent>
                <BusinessUnits connectionId={c.id} units={c.businessUnits} canManage={canManage} />
              </CardContent>
            </Card>
          )}
        </div>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle className="text-sm">Setup for a Salesforce administrator</CardTitle>
            <CardDescription className="text-xs">Full UI access does not grant API access. These steps must be done once in Marketing Cloud.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <ol className="list-decimal space-y-2 pl-4 text-[13px]">
              <li>Setup → Platform Tools → Apps → <b>Installed Packages</b> → New (e.g. “Niveshaay Archive – read only”).</li>
              <li>Add Component → <b>API Integration</b> → <b>Server-to-Server</b>.</li>
              <li>Grant only <b>Read</b> permissions (list on the right). Do not grant any write, send or execute permission.</li>
              <li>Under Access, enable the package for every Business Unit to be archived.</li>
              <li>Copy the <b>Client ID</b>, <b>Client Secret</b> and <b>Authentication Base URI</b> into this form, then Test connection.</li>
            </ol>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">Read scopes used by the archive</p>
              <div className="flex flex-wrap gap-1.5">
                {READ_SCOPES_RECOMMENDED.map((s) => (
                  <Pill key={s} tone={c?.grantedScopes.includes(s) ? "success" : "muted"}>{s}</Pill>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Scope names as they appear in tokens; the package editor shows them as “Read” checkboxes per area (Data Extensions, Email, Tracking Events, List and Subscribers, Journeys, Automations, Saved Content, Documents and Images, Accounts).</p>
            </div>
            <Notice tone="info" title="What the API cannot provide">
              Data views (_Sent, _Open…) need a SQL Query Activity writing into a Data Extension, and Data Extracts need SFTP. Both change the source account, so the archive never runs them automatically — see docs/salesforce-archive.md for the labelled manual workflow.
            </Notice>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
