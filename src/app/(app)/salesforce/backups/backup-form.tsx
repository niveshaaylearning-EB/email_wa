"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarClockIcon, Loader2Icon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Notice } from "@/components/app/empty-state";
import { api, errorMessage } from "@/lib/client/api";
import { istLocalToUtc } from "@/lib/time";

interface Option {
  key: string;
  label: string;
  group: string;
}

const PRESETS: Record<string, { label: string; keys: string[] }> = {
  full: { label: "Everything accessible", keys: [] },
  audit: { label: "SEBI audit essentials", keys: ["business_units", "de_metadata", "de_rows", "subscribers", "email_jobs", "tracking_sent", "tracking_notsent", "tracking_bounce", "tracking_unsub", "content"] },
  metadata: { label: "Metadata only", keys: ["business_units", "folders", "de_metadata", "lists", "email_jobs", "triggered_sends", "journeys", "automations", "content"] },
};

export function BackupForm({ connections, options }: { connections: { id: string; name: string; kind: string; status: string; businessUnits: { mid: string; name: string; selected: boolean }[] }[]; options: Option[] }) {
  const router = useRouter();
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const conn = connections.find((c) => c.id === connectionId);
  const [mids, setMids] = useState<Set<string>>(new Set(conn?.businessUnits.filter((b) => b.selected).map((b) => b.mid) ?? []));
  const [types, setTypes] = useState<Set<string>>(new Set(PRESETS.audit.keys));
  const [mode, setMode] = useState<"FULL" | "INCREMENTAL">("FULL");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [deKeys, setDeKeys] = useState("");
  const [jobIds, setJobIds] = useState("");
  const [intervalHours, setIntervalHours] = useState("24");
  const [busy, setBusy] = useState<string | null>(null);
  const groups = useMemo(() => [...new Set(options.map((o) => o.group))], [options]);
  const toggle = (set: Set<string>, k: string, on: boolean) => {
    const n = new Set(set);
    if (on) n.add(k);
    else n.delete(k);
    return n;
  };
  const lines = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
  const tracking = [...types].some((t) => t.startsWith("tracking_"));
  const valid = connectionId && mids.size && types.size;

  const start = async () => {
    setBusy("start");
    try {
      const r = await api<{ id: string; code: string }>("/api/v1/salesforce/backups", {
        body: {
          connectionId,
          mids: [...mids],
          dataTypes: [...types],
          mode,
          deKeys: lines(deKeys),
          jobIds: lines(jobIds),
          ...(from ? { dateFrom: istLocalToUtc(`${from}T00:00`).toISOString() } : {}),
          ...(to ? { dateTo: istLocalToUtc(`${to}T23:59`).toISOString() } : {}),
        },
      });
      toast.success(`Backup ${r.code} queued`);
      router.push(`/salesforce/backups/${r.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const schedule = async () => {
    setBusy("schedule");
    try {
      await api("/api/v1/salesforce/schedules", { body: { connectionId, name: `Every ${intervalHours}h · ${[...types].length} data types`, mids: [...mids], dataTypes: [...types], intervalHours: Number(intervalHours) } });
      toast.success("Schedule created — runs incrementally while Salesforce remains accessible.");
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!connections.length) return <Notice tone="info" title="Configure a Salesforce connection first." />;

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <div className="space-y-4">
          {connections.length > 1 && (
            <div className="space-y-1.5">
              <Label className="text-[13px]">Connection</Label>
              <select className="h-8 w-full rounded-md border bg-background px-2 text-sm" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.kind.toLowerCase()})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-[13px]">Business units</Label>
            {conn?.businessUnits.length ? (
              <ul className="space-y-1.5">
                {conn.businessUnits.map((b) => (
                  <li key={b.mid}>
                    <label className="flex items-center gap-2 text-sm">
                      <Checkbox checked={mids.has(b.mid)} onCheckedChange={(v) => setMids((s) => toggle(s, b.mid, !!v))} />
                      <span className="truncate">{b.name}</span>
                      <span className="ml-auto font-mono text-xs text-muted-foreground">{b.mid}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Discover business units on the Connection page first.</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="text-[13px]">Mode</Label>
            <ToggleGroup type="single" variant="outline" size="sm" value={mode} onValueChange={(v) => v && setMode(v as typeof mode)}>
              <ToggleGroupItem value="FULL">Full</ToggleGroupItem>
              <ToggleGroupItem value="INCREMENTAL">Incremental</ToggleGroupItem>
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">{mode === "FULL" ? "All accessible history for the selected data." : "Send jobs since the last successful backup, plus re-extraction of tracking for jobs sent in the last 14 days. Metadata and DE rows are always full."}</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-[13px]">Sends from</Label>
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[13px]">to</Label>
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Presets</span>
            {Object.entries(PRESETS).map(([k, p]) => (
              <Button key={k} size="xs" variant="outline" onClick={() => setTypes(new Set(p.keys.length ? p.keys : options.map((o) => o.key)))}>
                {p.label}
              </Button>
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {groups.map((g) => (
              <fieldset key={g} className="rounded-lg border p-3">
                <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g}</legend>
                <ul className="space-y-1.5">
                  {options
                    .filter((o) => o.group === g)
                    .map((o) => (
                      <li key={o.key}>
                        <label className="flex items-start gap-2 text-sm">
                          <Checkbox className="mt-0.5" checked={types.has(o.key)} onCheckedChange={(v) => setTypes((s) => toggle(s, o.key, !!v))} />
                          {o.label}
                        </label>
                      </li>
                    ))}
                </ul>
              </fieldset>
            ))}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[13px]">Only these Data Extensions (CustomerKeys, optional)</Label>
              <Textarea rows={3} placeholder="Leave empty for all visible Data Extensions" value={deKeys} onChange={(e) => setDeKeys(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[13px]">Only these JobIDs (optional)</Label>
              <Textarea rows={3} placeholder={tracking ? "Leave empty for every send job in the date window" : "Applies to tracking extraction"} value={jobIds} onChange={(e) => setJobIds(e.target.value)} />
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t pt-4">
        <Button disabled={!valid || !!busy} onClick={start}>
          {busy === "start" ? <Loader2Icon className="animate-spin" /> : <PlayIcon />} Start backup
        </Button>
        <div className="flex items-center gap-2">
          <Input className="h-8 w-20" inputMode="numeric" value={intervalHours} onChange={(e) => setIntervalHours(e.target.value.replace(/\D/g, ""))} aria-label="Interval hours" />
          <span className="text-xs text-muted-foreground">hours</span>
          <Button variant="outline" disabled={!valid || !!busy || Number(intervalHours) < 6} onClick={schedule}>
            {busy === "schedule" ? <Loader2Icon className="animate-spin" /> : <CalendarClockIcon />} Schedule recurring
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Extraction runs in the background, page by page, and can be cancelled between batches. Nothing in Salesforce changes.</p>
      </div>
    </div>
  );
}
