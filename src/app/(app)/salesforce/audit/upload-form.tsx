"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2Icon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { istLocalToUtc } from "@/lib/time";

/** Upload an independently preserved audience file (multipart; stored unaltered with SHA-256). */
export function UploadForm({ connections }: { connections: { id: string; name: string; mids: string[] }[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState("");
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? "");
  const [mid, setMid] = useState(connections[0]?.mids[0] ?? "");
  const [historical, setHistorical] = useState(false);
  const [snapshotDate, setSnapshotDate] = useState("");
  const [evidence, setEvidence] = useState("");
  const [attest, setAttest] = useState(false);
  const [busy, setBusy] = useState(false);
  const ok = label.trim().length >= 3 && connectionId && /^\d+$/.test(mid) && (!historical || (attest && evidence.trim().length >= 20 && snapshotDate));

  const submit = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) return toast.error("Choose a CSV file.");
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("meta", JSON.stringify({ label, connectionId, mid, historical, attest, evidenceNote: evidence || undefined, snapshotDate: snapshotDate ? istLocalToUtc(`${snapshotDate}T00:00`).toISOString() : undefined }));
      const res = await fetch("/api/v1/salesforce/uploads", { method: "POST", body: fd, headers: { "x-ncc-request": "1" }, credentials: "same-origin" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message ?? `Upload failed (${res.status})`);
      toast.success(`Uploaded ${json.data.rows} rows · SHA-256 ${String(json.data.sha256).slice(0, 12)}…`);
      for (const w of json.data.warnings ?? []) toast.warning(w);
      setLabel("");
      setEvidence("");
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="space-y-1.5 md:col-span-2">
          <Label className="text-[13px]">Label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Q3 research audience — file imported 11 Sep 2025" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[13px]">Business unit (MID)</Label>
          <div className="flex gap-2">
            {connections.length > 1 && (
              <select className="h-8 rounded-md border bg-background px-2 text-sm" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            <Input inputMode="numeric" value={mid} onChange={(e) => setMid(e.target.value.replace(/\D/g, ""))} />
          </div>
        </div>
      </div>
      <Input ref={fileRef} type="file" accept=".csv,text/csv" />
      <label className="flex items-start gap-2 text-sm">
        <Checkbox className="mt-0.5" checked={historical} onCheckedChange={(v) => setHistorical(!!v)} />
        <span>This file is the audience <b>as it was at send time</b> (I can describe the evidence)</span>
      </label>
      {historical && (
        <div className="grid gap-3 rounded-lg border border-warning/30 bg-warning/5 p-3 md:grid-cols-[180px_1fr]">
          <div className="space-y-1.5">
            <Label className="text-[13px]">Snapshot date</Label>
            <Input type="date" value={snapshotDate} onChange={(e) => setSnapshotDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-[13px]">Evidence</Label>
            <Textarea rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Where the file came from, who produced it, how it was used for the send (e.g. import activity log, email with attachment dated …)" />
          </div>
          <label className="flex items-start gap-2 text-xs md:col-span-2">
            <Checkbox className="mt-0.5" checked={attest} onCheckedChange={(v) => setAttest(!!v)} />
            I attest that this description is accurate. My name will appear on every report that relies on this snapshot.
          </label>
        </div>
      )}
      <Button size="sm" disabled={!ok || busy} onClick={submit}>
        {busy ? <Loader2Icon className="animate-spin" /> : <UploadIcon />} Upload snapshot
      </Button>
    </div>
  );
}
