import { requirePageUser } from "@/lib/auth/guard";
import { listIntegrationsForUi } from "@/lib/services/integrations";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/app/page-header";
import { Notice } from "@/components/app/empty-state";
import { hasPermission } from "@/lib/auth/permissions";
import { env } from "@/lib/env";
import { ZOHO_DATA_CENTERS } from "@/lib/providers/zoho/dc";
import { redirectUri } from "@/lib/providers/zoho/oauth";
import { daysAgo } from "@/lib/time";
import { IntegrationCards } from "./integration-cards";
import { SyncHistory } from "./sync-history";
import { ShieldCheckIcon, ShieldAlertIcon } from "lucide-react";

export const metadata = { title: "Integrations" };

export default async function IntegrationsPage({ searchParams }: PageProps<"/integrations">) {
  const user = await requirePageUser("integrations:read");
  const sp = await searchParams;
  const [integrations, runs, webhookStats] = await Promise.all([
    listIntegrationsForUi(),
    prisma.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: 15 }),
    prisma.webhookEvent.groupBy({ by: ["status"], where: { receivedAt: { gt: daysAgo(7) } }, _count: true }),
  ]);
  const e = env();
  const oauth = typeof sp.oauth === "string" ? sp.oauth : null;
  return (
    <div className="animate-in-fade space-y-5">
      <PageHeader title="Integrations" description="Provider credentials are encrypted at rest (AES-256-GCM) and never sent to the browser — only masked hints are shown." />
      {oauth === "connected" && <Notice tone="success" title="Zoho connected">OAuth completed. Run “Test connection”, then switch the mode when ready.</Notice>}
      {oauth && oauth !== "connected" && (
        <Notice tone="danger" title="Zoho connection failed">
          {oauth === "state_mismatch" ? "Security check failed (state mismatch). Start the connection again." : oauth === "denied" ? "Access was denied in Zoho." : typeof sp.message === "string" ? sp.message : "Unknown error."}
        </Notice>
      )}
      <Notice tone={e.ALLOW_LIVE_SEND ? "danger" : "success"} icon={e.ALLOW_LIVE_SEND ? ShieldAlertIcon : ShieldCheckIcon} title={e.ALLOW_LIVE_SEND ? "Live sending is ENABLED on this deployment" : "Live sending is disabled on this deployment"}>
        {e.ALLOW_LIVE_SEND
          ? "Providers in LIVE mode can send real messages for campaigns approved as live."
          : "ALLOW_LIVE_SEND is not 'true', so no provider send endpoint can be called regardless of the modes below. MOCK simulates; DRY-RUN validates and renders without sending. Zoho CRM sync (read-only) may still run against the real account."}
      </Notice>
      <IntegrationCards
        integrations={integrations}
        canWrite={hasPermission(user.role, "integrations:write")}
        canSync={hasPermission(user.role, "sync:run")}
        isAdmin={user.role === "ADMIN"}
        dataCenters={ZOHO_DATA_CENTERS.map((d) => ({ key: d.key, label: d.label, maVerified: d.marketingAutomationVerified, apiVerified: d.apiDomainVerified, ma: d.marketingAutomation }))}
        zohoRedirectUri={redirectUri()}
        webhookUrl={`${e.APP_URL}/api/webhooks/doubletick/status`}
        webhookStats={Object.fromEntries(webhookStats.map((w) => [w.status, w._count]))}
        liveAllowed={e.ALLOW_LIVE_SEND}
      />
      <SyncHistory runs={runs.map((r) => ({ id: r.id, provider: r.provider, type: r.type, status: r.status, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, stats: r.stats as Record<string, unknown>, apiCalls: r.apiCalls, errorMessage: r.errorMessage }))} />
    </div>
  );
}
