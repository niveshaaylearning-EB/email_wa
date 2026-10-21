import { WorkflowIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { listAutomations, listJourneys } from "@/lib/services/salesforce/queries";
import { PageHeader, SectionTitle } from "@/components/app/page-header";
import { EmptyState, Notice } from "@/components/app/empty-state";
import { UrlSearch } from "@/components/app/url-controls";
import { Pill } from "@/components/app/status";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SimulatedBadge } from "@/components/salesforce/status";
import { formatIST } from "@/lib/time";

export const metadata = { title: "Journey & Automation Archive" };

const AUTOMATION_STATUS: Record<string, string> = { "-1": "Error", "0": "Building error", "1": "Building", "2": "Ready", "3": "Running", "4": "Paused", "5": "Stopped", "6": "Scheduled", "7": "Awaiting trigger", "8": "Inactive trigger" };

function Json({ value }: { value: unknown }) {
  return <pre className="max-h-80 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[11px] leading-relaxed">{JSON.stringify(value, null, 2)}</pre>;
}

export default async function JourneysPage({ searchParams }: PageProps<"/salesforce/journeys">) {
  await requirePageUser("archive:read");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const [journeys, automations] = await Promise.all([listJourneys(q), listAutomations(q)]);
  const autos = automations.filter((a) => a.kind === "AUTOMATION");
  const queries = automations.filter((a) => a.kind === "QUERY_DEFINITION");

  return (
    <div className="animate-in-fade space-y-5">
      <PageHeader title="Journey & Automation Archive" description="Definitions retrieved through documented read APIs (Journey Builder REST, Automation Studio SOAP objects). Nothing is executed, paused or modified." />
      <Notice tone="info" title="What these APIs do not provide">
        Journey definitions do not include per-contact history or execution logs, and the SOAP Automation object does not expose full activity steps or run history. Those gaps are recorded with each item rather than hidden.
      </Notice>
      <UrlSearch placeholder="Search name or key" />
      <Tabs defaultValue="journeys">
        <TabsList>
          <TabsTrigger value="journeys">Journeys ({journeys.length})</TabsTrigger>
          <TabsTrigger value="automations">Automations ({autos.length})</TabsTrigger>
          <TabsTrigger value="queries">SQL query activities ({queries.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="journeys" className="mt-4">
          {journeys.length ? (
            <ul className="space-y-2">
              {journeys.map((j) => {
                const activities = j.activities as { key?: string; type?: string; name?: string }[];
                const triggers = j.entrySources as { type?: string; eventDefinitionKey?: string }[];
                return (
                  <li key={j.id} className="rounded-xl border bg-card">
                    <details>
                      <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-4 py-3">
                        <span className="min-w-0 flex-1">
                          <span className="font-medium">{j.name ?? j.key}</span>
                          <span className="ml-2 text-xs text-muted-foreground">v{j.version} · {j.key} · MID {j.mid}</span>
                        </span>
                        {j.isSimulated && <SimulatedBadge />}
                        <Pill tone={j.status === "Published" ? "success" : j.status === "Draft" ? "muted" : "neutral"}>{j.status ?? "—"}</Pill>
                        <span className="text-xs text-muted-foreground">{activities.length} activities · entry: {triggers.map((t) => t.type).join(", ") || "—"}</span>
                        <span className="text-xs text-muted-foreground">modified {j.modifiedDate ?? "—"}</span>
                      </summary>
                      <div className="grid gap-4 border-t p-4 lg:grid-cols-2">
                        <div>
                          <SectionTitle title="Activities" />
                          <ol className="space-y-1 text-sm">
                            {activities.map((a, i) => (
                              <li key={a.key ?? i} className="flex gap-2"><span className="tabular text-muted-foreground">{i + 1}.</span><span className="font-medium">{a.name ?? a.key}</span><Pill tone="muted">{a.type}</Pill></li>
                            ))}
                          </ol>
                          <SectionTitle title="Not available from the API" />
                          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                            {(j.gaps as string[]).map((g) => <li key={g}>{g}</li>)}
                          </ul>
                        </div>
                        <div>
                          <SectionTitle title="Entry sources & configuration" />
                          <Json value={{ triggers: j.entrySources, activities: j.activities }} />
                          <p className="mt-2 text-[11px] text-muted-foreground">Archived from dataset {j.datasetId} · last refreshed {formatIST(j.lastSeenAt)}. The full raw API response is preserved in the dataset’s raw pages.</p>
                        </div>
                      </div>
                    </details>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon={WorkflowIcon} title="No journeys archived" description="Run a backup with “Journey Builder configurations” selected." />
          )}
        </TabsContent>
        <TabsContent value="automations" className="mt-4">
          {autos.length ? (
            <ul className="space-y-2">
              {autos.map((a) => (
                <li key={a.id} className="rounded-xl border bg-card">
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-4 py-3">
                      <span className="min-w-0 flex-1 font-medium">{a.name ?? a.customerKey}<span className="ml-2 text-xs font-normal text-muted-foreground">{a.customerKey} · MID {a.mid}</span></span>
                      <Pill tone="muted">{AUTOMATION_STATUS[a.status ?? ""] ?? a.status ?? "—"}</Pill>
                      <span className="text-xs text-muted-foreground">last run {(a.schedule as Record<string, string | null>).LastRunTime ?? "—"}</span>
                    </summary>
                    <div className="grid gap-4 border-t p-4 lg:grid-cols-2">
                      <div className="space-y-2 text-sm">
                        {a.description && <p>{a.description}</p>}
                        <Json value={a.schedule} />
                      </div>
                      <div>
                        <SectionTitle title="Not available from the API" />
                        <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">{(a.gaps as string[]).map((g) => <li key={g}>{g}</li>)}</ul>
                      </div>
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={WorkflowIcon} title="No automations archived" description="Run a backup with “Automation Studio definitions & SQL queries” selected." />
          )}
        </TabsContent>
        <TabsContent value="queries" className="mt-4">
          {queries.length ? (
            <ul className="space-y-2">
              {queries.map((qd) => {
                const t = (qd.activities as { target?: string; targetKey?: string; updateType?: string }[])[0] ?? {};
                return (
                  <li key={qd.id} className="rounded-xl border bg-card p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="font-medium">{qd.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">{qd.customerKey}</span>
                      <span className="ml-auto text-xs text-muted-foreground">→ {t.target} ({t.updateType})</span>
                    </div>
                    <pre className="overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-[12px]">{qd.definition}</pre>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon={WorkflowIcon} title="No SQL query activities archived" />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
