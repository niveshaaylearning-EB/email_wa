"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2Icon, KeyRoundIcon, Loader2Icon, PlugZapIcon, SaveIcon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Notice } from "@/components/app/empty-state";
import { Pill } from "@/components/app/status";
import { api, errorMessage } from "@/lib/client/api";
import type { ConnectionView } from "@/lib/services/salesforce/connections";

interface TestResult {
  ok: boolean;
  latencyMs: number;
  message?: string;
  hint?: string;
  scopes: string[];
  missingScopes: string[];
  capabilities: Record<string, { label: string; scope: string; status: string; message?: string }>;
}

function Field({ label, hint, children, htmlFor }: { label: string; hint?: React.ReactNode; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-[13px]">
        {label}
      </Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ConnectionForm({ connection, canManage, simulatedAllowed }: { connection: ConnectionView | null; canManage: boolean; simulatedAllowed: boolean }) {
  const router = useRouter();
  const s = connection?.settings;
  const [form, setForm] = useState({
    name: connection?.name ?? "Niveshaay Marketing Cloud",
    kind: (connection?.kind ?? "LIVE") as "LIVE" | "SIMULATED",
    authBaseUri: connection?.authBaseUri ?? "",
    restBaseUri: connection?.restBaseUri ?? "",
    soapBaseUri: connection?.soapBaseUri ?? "",
    defaultMid: connection?.defaultMid ?? "",
    clientId: "",
    clientSecret: "",
    sourceUtcOffset: s?.sourceUtcOffset ?? "-06:00",
    sourceUtcOffsetConfirmed: s?.sourceUtcOffsetConfirmed ?? false,
    retentionDays: String(s?.retention.soapTracking.days ?? 730),
    retentionConfirmed: s?.retention.soapTracking.confirmed ?? false,
    retentionBasis: s?.retention.soapTracking.basis ?? "",
    maxConcurrent: String(s?.maxConcurrent ?? 2),
    minIntervalMs: String(s?.minIntervalMs ?? 250),
    pagesPerStep: String(s?.pagesPerStep ?? 10),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const disabled = !canManage;

  const save = async () => {
    setBusy("save");
    try {
      const body = {
        name: form.name,
        kind: form.kind,
        authBaseUri: form.authBaseUri,
        restBaseUri: form.restBaseUri,
        soapBaseUri: form.soapBaseUri,
        defaultMid: form.defaultMid,
        ...(form.clientId ? { clientId: form.clientId } : {}),
        ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
        settings: {
          sourceUtcOffset: form.sourceUtcOffset,
          sourceUtcOffsetConfirmed: form.sourceUtcOffsetConfirmed,
          maxConcurrent: Number(form.maxConcurrent),
          minIntervalMs: Number(form.minIntervalMs),
          pagesPerStep: Number(form.pagesPerStep),
          retention: { ...(s?.retention ?? {}), soapTracking: { days: Number(form.retentionDays) || null, confirmed: form.retentionConfirmed, basis: form.retentionBasis } },
        },
      };
      if (connection) await api(`/api/v1/salesforce/connections/${connection.id}`, { method: "PATCH", body });
      else await api(`/api/v1/salesforce/connections`, { body });
      setForm((f) => ({ ...f, clientId: "", clientSecret: "" }));
      toast.success("Connection saved. Credentials are encrypted at rest.");
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const test = async () => {
    if (!connection) return;
    setBusy("test");
    try {
      const r = await api<TestResult>(`/api/v1/salesforce/connections/${connection.id}/test`, { method: "POST" });
      setResult(r);
      (r.ok ? toast.success : toast.error)(r.ok ? `Authenticated in ${r.latencyMs} ms` : (r.message ?? "Connection failed"));
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Connection name" htmlFor="c-name">
          <Input id="c-name" value={form.name} onChange={(e) => set("name", e.target.value)} disabled={disabled} />
        </Field>
        <Field label="Type" hint={form.kind === "SIMULATED" ? "Synthetic data from the built-in simulator — for training and testing only." : "Real Marketing Cloud tenant (read-only)."}>
          <Select value={form.kind} onValueChange={(v) => set("kind", v)} disabled={disabled || !!connection}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="LIVE">Salesforce Marketing Cloud (live, read-only)</SelectItem>
              {simulatedAllowed && <SelectItem value="SIMULATED">Simulated tenant (development only)</SelectItem>}
            </SelectContent>
          </Select>
        </Field>
      </div>

      {form.kind === "LIVE" && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Authentication Base URI" htmlFor="c-auth" hint="From the Installed Package → API Integration component, e.g. https://mcXXXXXXXX.auth.marketingcloudapis.com/">
              <Input id="c-auth" value={form.authBaseUri} onChange={(e) => set("authBaseUri", e.target.value)} placeholder="https://mc….auth.marketingcloudapis.com/" disabled={disabled} />
            </Field>
            <Field label="Business Unit MID (account_id)" htmlFor="c-mid" hint="Optional. Without it, tokens are scoped to the BU where the package was created.">
              <Input id="c-mid" inputMode="numeric" value={form.defaultMid} onChange={(e) => set("defaultMid", e.target.value.replace(/\D/g, ""))} placeholder="e.g. 510000123" disabled={disabled} />
            </Field>
            <Field label="Client ID" htmlFor="c-cid" hint={connection?.secretHints.clientId ? <span className="inline-flex items-center gap-1"><KeyRoundIcon className="size-3" /> stored {connection.secretHints.clientId} — leave blank to keep</span> : "Never shown again after saving."}>
              <Input id="c-cid" autoComplete="off" value={form.clientId} onChange={(e) => set("clientId", e.target.value)} disabled={disabled} />
            </Field>
            <Field label="Client Secret" htmlFor="c-sec" hint={connection?.secretHints.clientSecret ? <span className="inline-flex items-center gap-1"><KeyRoundIcon className="size-3" /> stored {connection.secretHints.clientSecret} — leave blank to keep</span> : "Encrypted with AES-256-GCM; never sent to the browser."}>
              <Input id="c-sec" type="password" autoComplete="new-password" value={form.clientSecret} onChange={(e) => set("clientSecret", e.target.value)} disabled={disabled} />
            </Field>
          </div>
          <details className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
            <summary className="cursor-pointer text-[13px] font-medium">Advanced: REST / SOAP base URI overrides</summary>
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <Field label="REST Base URI" hint="Normally taken from the token response (rest_instance_url).">
                <Input value={form.restBaseUri} onChange={(e) => set("restBaseUri", e.target.value)} placeholder="auto" disabled={disabled} />
              </Field>
              <Field label="SOAP Base URI" hint="Normally taken from the token response (soap_instance_url).">
                <Input value={form.soapBaseUri} onChange={(e) => set("soapBaseUri", e.target.value)} placeholder="auto" disabled={disabled} />
              </Field>
            </div>
          </details>
        </>
      )}

      <div className="rounded-xl border p-4">
        <p className="mb-3 text-sm font-semibold">Evidence settings</p>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Source timestamp offset" hint="SFMC often returns timestamps without an offset; Marketing Cloud system time is widely reported as CST (UTC−06:00, no DST). Raw strings are always preserved.">
            <div className="flex items-center gap-3">
              <Input className="w-28" value={form.sourceUtcOffset} onChange={(e) => set("sourceUtcOffset", e.target.value)} disabled={disabled} />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={form.sourceUtcOffsetConfirmed} onCheckedChange={(v) => set("sourceUtcOffsetConfirmed", v)} disabled={disabled} /> Confirmed for this account
              </label>
            </div>
          </Field>
          <Field label="SOAP tracking retention (days)" hint="Used only to label missing history as NOT RETRIEVABLE. Never used to fabricate or discard data.">
            <div className="flex items-center gap-3">
              <Input className="w-28" inputMode="numeric" value={form.retentionDays} onChange={(e) => set("retentionDays", e.target.value.replace(/\D/g, ""))} disabled={disabled} />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={form.retentionConfirmed} onCheckedChange={(v) => set("retentionConfirmed", v)} disabled={disabled} /> Confirmed with Salesforce
              </label>
            </div>
          </Field>
          <Field label="Retention basis / reference" hint="Record where the retention figure comes from (case number, documentation, contract).">
            <Textarea rows={2} value={form.retentionBasis} onChange={(e) => set("retentionBasis", e.target.value)} disabled={disabled} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Parallel calls">
              <Input inputMode="numeric" value={form.maxConcurrent} onChange={(e) => set("maxConcurrent", e.target.value.replace(/\D/g, ""))} disabled={disabled} />
            </Field>
            <Field label="Min gap (ms)">
              <Input inputMode="numeric" value={form.minIntervalMs} onChange={(e) => set("minIntervalMs", e.target.value.replace(/\D/g, ""))} disabled={disabled} />
            </Field>
            <Field label="Pages / step">
              <Input inputMode="numeric" value={form.pagesPerStep} onChange={(e) => set("pagesPerStep", e.target.value.replace(/\D/g, ""))} disabled={disabled} />
            </Field>
          </div>
        </div>
      </div>

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={save} disabled={!!busy}>
            {busy === "save" ? <Loader2Icon className="animate-spin" /> : <SaveIcon />} Save
          </Button>
          {connection && (
            <Button variant="outline" onClick={test} disabled={!!busy}>
              {busy === "test" ? <Loader2Icon className="animate-spin" /> : <PlugZapIcon />} Test connection
            </Button>
          )}
          <span className="text-xs text-muted-foreground">Test connection authenticates and runs one read-only probe per capability.</span>
        </div>
      )}

      {result && (
        <div className="space-y-3">
          {result.ok ? (
            <Notice tone="success" icon={CheckCircle2Icon} title={`Authenticated (${result.latencyMs} ms)`}>
              Granted scopes: {result.scopes.join(", ") || "none reported"}
            </Notice>
          ) : (
            <Notice tone="danger" icon={XCircleIcon} title={result.message ?? "Connection failed"}>
              {result.hint}
            </Notice>
          )}
          {result.missingScopes.length > 0 && result.ok && (
            <Notice tone="warning" title="Recommended read scopes not granted">
              <span className="flex flex-wrap gap-1.5">{result.missingScopes.map((m) => <Pill key={m} tone="warning">{m}</Pill>)}</span>
            </Notice>
          )}
        </div>
      )}
    </div>
  );
}
