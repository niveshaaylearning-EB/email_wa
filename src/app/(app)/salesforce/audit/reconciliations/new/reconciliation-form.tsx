"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { GitCompareArrowsIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Notice } from "@/components/app/empty-state";
import { api, errorMessage } from "@/lib/client/api";
import { istLocalToUtc } from "@/lib/time";

export interface AudienceOption {
  id: string;
  kind: string;
  label: string;
  mid: string;
  records: number;
  extractedAt: string | null;
  fields: string[];
  current: boolean;
  historicalUpload: boolean;
  simulated: boolean;
}

export interface JobOption {
  jobId: string;
  mid: string;
  emailName: string | null;
  sendDate: string | null;
  sentTracked: boolean;
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <p className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <span className="grid size-5 place-items-center rounded-full bg-primary/10 text-[11px] text-primary">{n}</span>
        {title}
      </p>
      {children}
    </section>
  );
}

export function ReconciliationForm({ audiences, jobs, defaults }: { audiences: AudienceOption[]; jobs: JobOption[]; defaults: { mid?: string; jobId?: string } }) {
  const router = useRouter();
  const [mid, setMid] = useState(defaults.mid ?? jobs[0]?.mid ?? "");
  const [jobIds, setJobIds] = useState<Set<string>>(new Set(defaults.jobId ? [defaults.jobId] : []));
  const [jobFilter, setJobFilter] = useState("");
  const midAudiences = audiences.filter((a) => a.mid === mid);
  const [audienceId, setAudienceId] = useState(midAudiences.find((a) => a.current)?.id ?? "");
  const audience = audiences.find((a) => a.id === audienceId);
  const [field, setField] = useState("");
  const [mode, setMode] = useState<"SUBSCRIBER_KEY" | "EMAIL">("SUBSCRIBER_KEY");
  const [caseInsensitive, setCaseInsensitive] = useState(false);
  const [trim, setTrim] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [exclusions, setExclusions] = useState<Set<string>>(new Set());
  const [historical, setHistorical] = useState(false);
  const [evidence, setEvidence] = useState("");
  const [attest, setAttest] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const fieldValue = field || (audience?.fields.find((f) => /subscriberkey/i.test(f)) ?? audience?.fields.find((f) => /email/i.test(f)) ?? audience?.fields[0] ?? "");
  const midJobs = useMemo(() => jobs.filter((j) => j.mid === mid && (!jobFilter || j.jobId.includes(jobFilter) || (j.emailName ?? "").toLowerCase().includes(jobFilter.toLowerCase()))), [jobs, mid, jobFilter]);
  const selectedJobs = jobs.filter((j) => jobIds.has(j.jobId));
  const firstSend = selectedJobs.map((j) => j.sendDate).filter(Boolean).sort()[0] ?? null;
  const extractedAfter = !!(audience?.extractedAt && firstSend && audience.extractedAt > firstSend);
  const valid = name.trim().length >= 3 && mid && jobIds.size && audienceId && fieldValue && (!historical || (evidence.trim().length >= 20 && attest));

  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ id: string; code: string }>("/api/v1/salesforce/reconciliations", {
        body: {
          name,
          mid,
          jobIds: [...jobIds],
          audienceDatasetId: audienceId,
          audienceField: fieldValue,
          identityMode: mode,
          caseInsensitive,
          trim,
          exclusionDatasetIds: [...exclusions],
          exclusionField: "SubscriberKey",
          ...(from ? { sendDateFrom: istLocalToUtc(`${from}T00:00`).toISOString() } : {}),
          ...(to ? { sendDateTo: istLocalToUtc(`${to}T23:59`).toISOString() } : {}),
          ...(historical && !audience?.historicalUpload ? { historicalClaim: { evidence, attest: true } } : {}),
        },
      });
      toast.success(`Reconciliation ${r.code} started`);
      router.push(`/salesforce/audit/reconciliations/${r.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Step n={1} title="Send job(s)">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label className="text-[13px]">Business unit (MID)</Label>
            <select className="h-8 rounded-md border bg-background px-2 text-sm" value={mid} onChange={(e) => { setMid(e.target.value); setJobIds(new Set()); setAudienceId(""); }}>
              {[...new Set(jobs.map((j) => j.mid))].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <Input className="h-8 w-64" placeholder="Filter by JobID or email name" value={jobFilter} onChange={(e) => setJobFilter(e.target.value)} />
        </div>
        <ul className="max-h-60 divide-y overflow-auto rounded-lg border">
          {midJobs.map((j) => (
            <li key={j.jobId}>
              <label className="flex items-center gap-3 px-3 py-2 text-sm">
                <Checkbox checked={jobIds.has(j.jobId)} onCheckedChange={(v) => setJobIds((s) => { const n = new Set(s); if (v) n.add(j.jobId); else n.delete(j.jobId); return n; })} />
                <span className="font-mono text-xs">{j.jobId}</span>
                <span className="min-w-0 flex-1 truncate">{j.emailName ?? "—"}</span>
                <span className="text-xs text-muted-foreground">{j.sendDate?.slice(0, 10) ?? "—"}</span>
                {!j.sentTracked && <span className="text-xs text-warning">no sent tracking archived</span>}
              </label>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted-foreground">Sent events from<Input type="date" className="h-8 w-40" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="text-xs text-muted-foreground">to<Input type="date" className="h-8 w-40" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <span className="text-xs text-muted-foreground">Optional — restricts SentEvents by event date (IST).</span>
        </div>
      </Step>

      <Step n={2} title="Audience">
        <ul className="max-h-64 divide-y overflow-auto rounded-lg border">
          {midAudiences.map((a) => (
            <li key={a.id}>
              <label className="flex items-center gap-3 px-3 py-2 text-sm">
                <input type="radio" name="audience" checked={audienceId === a.id} onChange={() => { setAudienceId(a.id); setField(""); }} />
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                {a.simulated && <span className="text-[10px] font-semibold uppercase text-warning">simulated</span>}
                {a.historicalUpload && <span className="text-xs text-info">historical (evidenced)</span>}
                {!a.current && a.kind === "DE_ROWS" && <span className="text-xs text-muted-foreground">older snapshot</span>}
                <span className="tabular text-xs text-muted-foreground">{a.records.toLocaleString("en-IN")} rows · {a.extractedAt?.slice(0, 10) ?? "—"}</span>
              </label>
            </li>
          ))}
          {!midAudiences.length && <li className="px-3 py-4 text-sm text-muted-foreground">No sealed DE snapshots or uploads for this MID.</li>}
        </ul>
        {audience && (
          <div className="mt-3 grid gap-3 md:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-[13px]">Identity field</Label>
              <select className="h-8 w-full rounded-md border bg-background px-2 text-sm" value={fieldValue} onChange={(e) => setField(e.target.value)}>
                {audience.fields.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[13px]">Field contains</Label>
              <select className="h-8 w-full rounded-md border bg-background px-2 text-sm" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                <option value="SUBSCRIBER_KEY">SubscriberKey</option>
                <option value="EMAIL">Email address (mapped via archived subscribers)</option>
              </select>
            </div>
            <label className="flex items-center gap-2 pt-6 text-sm"><Switch checked={trim} onCheckedChange={setTrim} /> Trim spaces</label>
            <label className="flex items-center gap-2 pt-6 text-sm"><Switch checked={caseInsensitive} onCheckedChange={setCaseInsensitive} /> Case-insensitive</label>
          </div>
        )}
        {audience && !audience.historicalUpload && (
          <div className="mt-4 space-y-2">
            <Notice tone="warning" icon={TriangleAlertIcon} title="This audience is treated as a current-state copy">
              A Data Extension backup shows the DE when it was extracted{extractedAfter ? " — here, after the send" : ""}. DEs are often overwritten by automations, so it is not assumed to be the send-time audience. Reports will say so.
            </Notice>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox className="mt-0.5" checked={historical} onCheckedChange={(v) => setHistorical(!!v)} />
              I have evidence that this snapshot equals the audience at send time
            </label>
            {historical && (
              <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
                <Textarea rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Describe the evidence (e.g. DE is overwrite-protected and was last modified before the send; import log …)" />
                <label className="flex items-start gap-2 text-xs"><Checkbox className="mt-0.5" checked={attest} onCheckedChange={(v) => setAttest(!!v)} /> I attest to this. My name and statement will appear in every report from this reconciliation.</label>
              </div>
            )}
          </div>
        )}
      </Step>

      <Step n={3} title="Optional evidence sources">
        <p className="mb-2 text-xs text-muted-foreground">Exclusion / suppression snapshots are used as <b>possible explanations</b> only — their contents at send time are unknown. Recipient-level NotSentEvents, subscriber status and earlier unsubscribe events are used automatically when archived.</p>
        <ul className="max-h-48 divide-y overflow-auto rounded-lg border">
          {midAudiences.filter((a) => a.id !== audienceId).map((a) => (
            <li key={a.id}>
              <label className="flex items-center gap-3 px-3 py-2 text-sm">
                <Checkbox checked={exclusions.has(a.id)} onCheckedChange={(v) => setExclusions((s) => { const n = new Set(s); if (v) n.add(a.id); else n.delete(a.id); return n; })} />
                <span className="min-w-0 flex-1 truncate">{a.label}</span>
                <span className="text-xs text-muted-foreground">{a.fields.includes("SubscriberKey") ? "SubscriberKey" : "no SubscriberKey field"}</span>
              </label>
            </li>
          ))}
        </ul>
      </Step>

      <Step n={4} title="Run">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-72 flex-1 space-y-1.5">
            <Label className="text-[13px]">Reconciliation name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Q3 research update — 18,000 vs 16,000 investigation" />
          </div>
          <Button disabled={!valid || busy} onClick={submit}>
            {busy ? <Loader2Icon className="animate-spin" /> : <GitCompareArrowsIcon />} Run reconciliation
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Results are frozen when the run completes; re-running creates a new reconciliation so earlier evidence is never overwritten.</p>
      </Step>
    </div>
  );
}
