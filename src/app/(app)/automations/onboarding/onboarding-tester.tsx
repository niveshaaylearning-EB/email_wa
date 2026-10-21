"use client";
// TEST MODULE — DoubleTick onboarding bot trigger. Remove after testing (docs/doubletick-onboarding-test.md).

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle2Icon, EyeIcon, Loader2Icon, SendIcon, XCircleIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Notice } from "@/components/app/empty-state";
import { Pill } from "@/components/app/status";
import { api, errorMessage } from "@/lib/client/api";
import { formatIST } from "@/lib/time";

interface Result {
  outcome: "preview" | "sent" | "failed" | "blocked";
  target: { kind: string; name: string; phoneE164: string | null };
  payload: { customerPhone: string; customerName: string } | null;
  blockers: string[];
  httpStatus?: number;
  providerResponse?: string;
  error?: string;
}

const TONE = { sent: "success", preview: "info", failed: "danger", blocked: "warning" } as const;

export function OnboardingTester({
  config,
  testRecipients,
  runs,
}: {
  config: { urlValid: boolean; triggerId: string | null; hasAuthKey: boolean; liveSendEnabled: boolean };
  testRecipients: { id: string; name: string; phoneE164: string | null }[];
  runs: { id: string; createdAt: string; actorEmail: string | null; metadata: Record<string, unknown> }[];
}) {
  const router = useRouter();
  const withPhone = testRecipients.filter((r) => r.phoneE164);
  const [recipientId, setRecipientId] = useState(withPhone[0]?.id ?? "");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await api<Result>("/api/v1/automations/onboarding", { body: { testRecipientId: recipientId, dryRun, confirm: dryRun ? undefined : "SEND" } });
      setResult(r);
      if (r.outcome === "sent") toast.success("DoubleTick accepted the trigger — check the test phone for the welcome message.");
      if (r.outcome === "failed") toast.error(r.error ?? "Trigger failed");
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const ready = config.urlValid && config.hasAuthKey;
  const selected = withPhone.find((r) => r.id === recipientId);

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Configuration</CardTitle>
          <CardDescription className="text-xs">Read from .env — secrets are never sent to the browser.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label="Webhook URL" ok={config.urlValid} text={config.urlValid ? `bothook.io …/${config.triggerId?.slice(0, 8)}…` : "missing or invalid"} />
          <Row label="Trigger Authorization Key" ok={config.hasAuthKey} text={config.hasAuthKey ? "set (hidden)" : "not set"} />
          <Row label="Real clients" ok={false} text={config.liveSendEnabled ? "allowed only with consent (live switch ON)" : "blocked — test recipients only"} neutral />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Send a test</CardTitle>
          <CardDescription className="text-xs">Sends {`{ customerPhone, customerName }`} to the onboarding bot trigger.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {withPhone.length ? (
            <div className="space-y-1.5">
              <Label>Test recipient</Label>
              <Select value={recipientId} onValueChange={(v) => { setRecipientId(v); setResult(null); }}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {withPhone.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name} · {r.phoneE164}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <Notice tone="info">
              Add a test recipient with a mobile number you control in{" "}
              <Link href="/settings" className="underline">
                Settings → Test recipients
              </Link>
              .
            </Notice>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={!recipientId || busy} onClick={() => run(true).catch(() => undefined)}>
              {busy ? <Loader2Icon className="animate-spin" /> : <EyeIcon />} Preview request
            </Button>
            <ConfirmDialog
              trigger={
                <Button disabled={!recipientId || !ready || busy}>
                  <SendIcon /> Send real test message
                </Button>
              }
              title="Send a real WhatsApp message?"
              description={
                <>
                  <p>
                    DoubleTick will send the onboarding welcome message to <strong>{selected?.name}</strong> ({selected?.phoneE164}). This cannot be undone.
                  </p>
                  <p>Only continue if you control this number.</p>
                </>
              }
              typeToConfirm="SEND"
              confirmLabel="Send message"
              onConfirm={() => run(false)}
            />
          </div>
          {result && (
            <div className="space-y-2 rounded-lg border p-3 text-xs">
              <div className="flex items-center gap-2">
                <Pill tone={TONE[result.outcome]}>{result.outcome}</Pill>
                {result.httpStatus && <span className="text-muted-foreground">HTTP {result.httpStatus}</span>}
              </div>
              {result.payload && (
                <pre className="overflow-auto rounded bg-muted p-2">{`POST <bothook.io trigger URL>\nAuthorization: <trigger key>\nContent-Type: application/json\n\n${JSON.stringify(result.payload, null, 2)}`}</pre>
              )}
              {result.blockers.length > 0 && (
                <ul className="list-disc pl-4 text-warning">
                  {result.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              {result.error && <p className="text-destructive">{result.error}</p>}
              {result.providerResponse && <p className="text-muted-foreground">Response: {result.providerResponse}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Trigger history</CardTitle>
          <CardDescription className="text-xs">From the audit log. The trigger returns no message ID, so delivery can only be confirmed on the phone (or via DoubleTick status webhooks once registered).</CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length ? (
            <ul className="divide-y text-sm">
              {runs.map((r) => {
                const m = r.metadata as { outcome?: keyof typeof TONE; phone?: string; httpStatus?: number; error?: string; blockers?: string[] };
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
                    <span className="tabular w-40 text-xs text-muted-foreground">{formatIST(r.createdAt, "dd MMM, hh:mm:ss a")}</span>
                    {m.outcome && <Pill tone={TONE[m.outcome]}>{m.outcome}</Pill>}
                    <span className="font-mono text-xs">{m.phone ?? "—"}</span>
                    <span className="text-xs text-muted-foreground">
                      {r.actorEmail}
                      {m.httpStatus ? ` · HTTP ${m.httpStatus}` : ""}
                      {m.error ? ` · ${m.error}` : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No triggers yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, ok, text, neutral }: { label: string; ok: boolean; text: string; neutral?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex items-center gap-1.5">
        {!neutral && (ok ? <CheckCircle2Icon className="size-4 text-success" /> : <XCircleIcon className="size-4 text-destructive" />)}
        {text}
      </span>
    </div>
  );
}
