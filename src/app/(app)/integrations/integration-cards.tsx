"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CopyIcon, KeyRoundIcon, Link2Icon, Loader2Icon, PlugZapIcon, RefreshCwIcon, SaveIcon, UnplugIcon, AlertTriangleIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ModeBadge, Pill } from "@/components/app/status";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Notice } from "@/components/app/empty-state";
import { api, errorMessage } from "@/lib/client/api";
import { formatIST, relativeTime } from "@/lib/time";
import type { IntegrationView } from "@/lib/services/integrations";

interface DC {
  key: string;
  label: string;
  maVerified: boolean;
  apiVerified: boolean;
  ma: string;
}

const STATUS_TONE = { CONNECTED: "success", CONFIGURED: "info", ERROR: "danger", NOT_CONFIGURED: "muted", DISCONNECTED: "muted" } as const;

export function IntegrationCards(props: {
  integrations: IntegrationView[];
  canWrite: boolean;
  canSync: boolean;
  isAdmin: boolean;
  dataCenters: DC[];
  zohoRedirectUri: string;
  webhookUrl: string;
  webhookStats: Record<string, number>;
  liveAllowed: boolean;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      {props.integrations.map((i) => (
        <ProviderCard key={i.provider} i={i} {...props} />
      ))}
    </div>
  );
}

function ProviderCard({ i, canWrite, canSync, isAdmin, dataCenters, zohoRedirectUri, webhookUrl, webhookStats, liveAllowed }: { i: IntegrationView } & Parameters<typeof IntegrationCards>[0]) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [config, setConfig] = useState<Record<string, unknown>>(i.config);
  const isZoho = i.provider !== "DOUBLETICK";
  const connected = isZoho ? !!i.secretHints.refreshToken : !!i.secretHints.apiKey;
  const dc = dataCenters.find((d) => d.key === (config.dc as string)) ?? dataCenters[0];

  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast.success(ok);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    } finally {
      setBusy(null);
    }
  };
  const patch = (body: Record<string, unknown>, ok: string) => act("save", () => api(`/api/v1/integrations/${i.provider}`, { method: "PATCH", body }), ok);

  const test = () =>
    act("test", async () => {
      const r = await api<{ ok: boolean; message: string; adapter: string; latencyMs?: number }>(`/api/v1/integrations/${i.provider}/test`, { method: "POST", query: { real: connected ? "1" : undefined } });
      (r.ok ? toast.success : toast.error)(`${r.message}${r.latencyMs ? ` (${r.latencyMs} ms)` : ""}${r.adapter === "mock" ? " — mock adapter" : ""}`);
    }).catch(() => undefined);

  const secretFields = isZoho
    ? [
        ["clientId", "Client ID"],
        ["clientSecret", "Client secret"],
      ]
    : [
        ["apiKey", "API key"],
        ["webhookSecret", "Webhook bearer secret"],
      ];

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>{i.label}</span>
          <ModeBadge mode={i.mode} />
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2 text-xs">
          <Pill tone={STATUS_TONE[i.status]} dot>
            {i.status.replace("_", " ").toLowerCase()}
          </Pill>
          {i.provider === "ZOHO_CRM" && "Read-only client sync"}
          {i.provider === "ZOHO_MA" && "Bulk email campaigns"}
          {i.provider === "DOUBLETICK" && "WhatsApp template messages (API V2)"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 space-y-4 text-sm">
        <dl className="space-y-1.5 text-xs">
          <Row k="Last successful call" v={i.lastSuccessAt ? `${relativeTime(i.lastSuccessAt)} · ${formatIST(i.lastSuccessAt)}` : "never"} />
          {i.provider === "ZOHO_CRM" && <Row k="Last sync" v={i.lastSyncAt ? formatIST(i.lastSyncAt) : "never"} />}
          {i.apiUsage?.total !== undefined && <Row k="API calls (all time)" v={String(i.apiUsage.total)} />}
          {Object.entries(i.accountInfo ?? {})
            .filter(([k]) => ["apiDomain", "location", "accountsServer", "baseUrl"].includes(k))
            .map(([k, v]) => (
              <Row key={k} k={k} v={String(v)} />
            ))}
          {i.provider === "DOUBLETICK" && <Row k="Webhooks (7 days)" v={Object.entries(webhookStats).map(([s, n]) => `${s.toLowerCase()} ${n}`).join(" · ") || "none received"} />}
        </dl>
        {i.lastError && i.status === "ERROR" && (
          <Notice tone="danger" icon={AlertTriangleIcon} title={`Last error ${relativeTime(i.lastErrorAt)}`}>
            {i.lastError}
          </Notice>
        )}

        {canWrite && (
          <>
            <div className="space-y-2">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <KeyRoundIcon className="size-3.5" /> Credentials
              </p>
              {secretFields.map(([k, l]) => (
                <div key={k} className="grid grid-cols-[110px_1fr] items-center gap-2">
                  <Label className="text-xs text-muted-foreground" htmlFor={`${i.provider}-${k}`}>
                    {l}
                  </Label>
                  <Input
                    id={`${i.provider}-${k}`}
                    type="password"
                    autoComplete="off"
                    className="h-8 font-mono text-xs"
                    placeholder={i.secretHints[k] ?? "not set"}
                    value={secrets[k] ?? ""}
                    onChange={(e) => setSecrets((s) => ({ ...s, [k]: e.target.value }))}
                  />
                </div>
              ))}
              {isZoho && i.secretHints.refreshToken && <p className="text-xs text-muted-foreground">Refresh token stored: {i.secretHints.refreshToken}</p>}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Configuration</p>
              {isZoho && (
                <div className="grid grid-cols-[110px_1fr] items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Data center</Label>
                  <Select value={(config.dc as string) ?? "in"} onValueChange={(v) => setConfig((c) => ({ ...c, dc: v }))}>
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {dataCenters.map((d) => (
                        <SelectItem key={d.key} value={d.key}>
                          {d.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {i.provider === "ZOHO_CRM" && (
                <>
                  <ConfigInput label="Status field" k="statusField" config={config} setConfig={setConfig} placeholder="CRM field API name (optional)" />
                  <ConfigInput label="City field" k="cityField" config={config} setConfig={setConfig} placeholder="Mailing_City" />
                  <ConfigInput label="Extra fields" k="extraFields" list config={config} setConfig={setConfig} placeholder="Comma-separated API names for rules" />
                  <ConfigInput label="Inactive statuses" k="inactiveStatuses" list config={config} setConfig={setConfig} placeholder="Inactive, Closed" />
                  <ConfigInput label="Sync every (min)" k="syncIntervalMinutes" number config={config} setConfig={setConfig} />
                </>
              )}
              {i.provider === "ZOHO_MA" && (
                <>
                  <ConfigInput label="API base URL" k="baseUrl" config={config} setConfig={setConfig} placeholder={dc.ma} />
                  {!dc.maVerified && !config.baseUrl && <p className="text-xs text-warning">Regional Marketing Automation host for this DC is not documented by Zoho — confirm the URL for your account.</p>}
                  <ConfigInput label="From email" k="fromEmail" config={config} setConfig={setConfig} placeholder="Verified sender in Zoho" />
                  <ConfigInput label="From name" k="fromName" config={config} setConfig={setConfig} placeholder="Niveshaay" />
                  <ConfigInput label="Topic ID" k="topicId" config={config} setConfig={setConfig} placeholder="Required if topics are enabled" />
                  <ConfigInput label="List prefix" k="listPrefix" config={config} setConfig={setConfig} />
                </>
              )}
              {i.provider === "DOUBLETICK" && (
                <>
                  <ConfigInput label="Sender number" k="senderNumber" config={config} setConfig={setConfig} placeholder="+91… WABA number" />
                  <ConfigInput label="Throttle / min" k="throttlePerMinute" number config={config} setConfig={setConfig} />
                  <div className="grid grid-cols-[110px_1fr] items-center gap-2">
                    <Label className="text-xs text-muted-foreground">Auth header</Label>
                    <Select value={(config.authHeaderStyle as string) ?? "raw"} onValueChange={(v) => setConfig((c) => ({ ...c, authHeaderStyle: v }))}>
                      <SelectTrigger size="sm" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="raw">Authorization: &lt;key&gt;</SelectItem>
                        <SelectItem value="key_prefix">Authorization: key &lt;key&gt;</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={busy === "save"}
              onClick={() => {
                const s = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim()));
                patch({ config, ...(Object.keys(s).length ? { secrets: s } : {}) }, "Saved (secrets encrypted)")
                  .then(() => setSecrets({}))
                  .catch(() => undefined);
              }}
            >
              {busy === "save" ? <Loader2Icon className="animate-spin" /> : <SaveIcon />} Save
            </Button>
          </>
        )}

        <Collapsible>
          <CollapsibleTrigger className="text-xs font-medium text-primary hover:underline">Setup instructions</CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-2 text-xs text-muted-foreground">
            {isZoho ? (
              <>
                <p>1. In the Zoho API Console for your data center, create a <strong>Server-based Application</strong>.</p>
                <p className="flex items-center gap-1">
                  2. Authorised redirect URI:
                  <code className="truncate rounded bg-muted px-1">{zohoRedirectUri}</code>
                  <CopyButton text={zohoRedirectUri} />
                </p>
                <p>3. Enter client ID & secret above, save, then <strong>Connect</strong>. Scopes requested: {i.provider === "ZOHO_CRM" ? "ZohoCRM.modules.contacts.READ, ZohoCRM.coql.READ, ZohoCRM.settings.fields.READ" : "ZohoMarketingAutomation.campaign.ALL, ZohoMarketingAutomation.lead.ALL"}.</p>
                <p>4. Test the connection, then move from MOCK to DRY-RUN.</p>
                {!dc.apiVerified && <p>The CRM API domain is taken from Zoho’s token response (api_domain), so regional URLs are handled automatically.</p>}
              </>
            ) : (
              <>
                <p>1. Create an API key in DoubleTick (Settings → API). Restrict it to this server’s IP if possible.</p>
                <p>2. Register a webhook (DoubleTick Settings → Webhooks, or API) for event <code className="rounded bg-muted px-1">MESSAGE_STATUS_UPDATE</code>:</p>
                <p className="flex items-center gap-1">
                  URL <code className="truncate rounded bg-muted px-1">{webhookUrl}</code>
                  <CopyButton text={webhookUrl} />
                </p>
                <p>3. Set webhook authorization to <strong>Bearer</strong> with the webhook secret above. DoubleTick documents no payload signature, so this bearer token is the authenticity check — keep it secret and use HTTPS.</p>
                <p>4. Register each approved template name/language in the Template Library (templates are created and approved in DoubleTick).</p>
              </>
            )}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
      {canWrite && (
        <CardFooter className="flex flex-wrap gap-2 border-t pt-4">
          <Button size="sm" variant="outline" onClick={test} disabled={busy === "test"}>
            {busy === "test" ? <Loader2Icon className="animate-spin" /> : <PlugZapIcon />} Test connection
          </Button>
          {isZoho && (
            <Button size="sm" variant="outline" asChild>
              <a href={`/api/integrations/zoho/connect?provider=${i.provider}`}>
                <Link2Icon /> {connected ? "Reconnect" : "Connect"}
              </a>
            </Button>
          )}
          {isZoho && connected && (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="ghost">
                  <UnplugIcon /> Disconnect
                </Button>
              }
              title={`Disconnect ${i.label}?`}
              description="The refresh token is revoked at Zoho and deleted here. The integration returns to MOCK mode."
              destructive
              confirmLabel="Disconnect"
              onConfirm={() => act("disc", () => api(`/api/v1/integrations/${i.provider}/disconnect`, { method: "POST" }), "Disconnected")}
            />
          )}
          {i.provider === "ZOHO_CRM" && canSync && (
            <Button size="sm" variant="outline" disabled={busy === "sync"} onClick={() => act("sync", () => api("/api/v1/sync/crm", { body: { full: false } }), "Sync finished").catch(() => undefined)}>
              {busy === "sync" ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} Sync now
            </Button>
          )}
          <div className="ml-auto">
            <ModeSwitch provider={i.provider} mode={i.mode} isAdmin={isAdmin} liveAllowed={liveAllowed || i.provider === "ZOHO_CRM"} onChange={(mode) => patch({ mode }, `Mode set to ${mode}`)} />
          </div>
        </CardFooter>
      )}
    </Card>
  );
}

function ModeSwitch({ provider, mode, isAdmin, liveAllowed, onChange }: { provider: string; mode: string; isAdmin: boolean; liveAllowed: boolean; onChange: (m: string) => Promise<unknown> }) {
  const [pending, setPending] = useState<string | null>(null);
  return (
    <>
      <Select
        value={mode}
        onValueChange={(v) => {
          if (v === "LIVE") setPending(v);
          else onChange(v).catch(() => undefined);
        }}
      >
        <SelectTrigger size="sm" className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="MOCK">Mock</SelectItem>
          <SelectItem value="DRY_RUN">Dry run</SelectItem>
          <SelectItem value="LIVE" disabled={!isAdmin || !liveAllowed}>
            Live{!liveAllowed ? " (disabled)" : ""}
          </SelectItem>
        </SelectContent>
      </Select>
      {pending && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setPending(null)}
          title={provider === "ZOHO_CRM" ? "Use the real Zoho CRM account?" : "Enable LIVE sending?"}
          description={
            provider === "ZOHO_CRM"
              ? "CRM sync will read real contacts (read-only). No data is written to Zoho CRM."
              : "Campaigns approved after this change may send REAL messages to clients. Each campaign still needs maker-checker approval with an explicit live confirmation."
          }
          typeToConfirm="ENABLE LIVE"
          destructive
          confirmLabel="Enable LIVE"
          onConfirm={() => onChange("LIVE").finally(() => setPending(null))}
        />
      )}
    </>
  );
}

function ConfigInput({ label, k, config, setConfig, placeholder, list, number }: { label: string; k: string; config: Record<string, unknown>; setConfig: React.Dispatch<React.SetStateAction<Record<string, unknown>>>; placeholder?: string; list?: boolean; number?: boolean }) {
  const raw = config[k];
  const value = Array.isArray(raw) ? raw.join(", ") : raw === undefined || raw === null ? "" : String(raw);
  return (
    <div className="grid grid-cols-[110px_1fr] items-center gap-2">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input
        className="h-8 text-xs"
        placeholder={placeholder}
        value={value}
        type={number ? "number" : "text"}
        onChange={(e) =>
          setConfig((c) => ({
            ...c,
            [k]: list ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean) : number ? Number(e.target.value) : e.target.value || undefined,
          }))
        }
      />
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="truncate text-right">{v}</dd>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  return (
    <button type="button" aria-label="Copy" className="shrink-0 rounded p-0.5 hover:bg-muted" onClick={() => navigator.clipboard.writeText(text).then(() => toast.success("Copied"))}>
      <CopyIcon className="size-3" />
    </button>
  );
}
