"use client";

import { useState } from "react";
import { toast } from "sonner";
import { DownloadIcon, Loader2Icon, ShieldAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { api, errorMessage } from "@/lib/client/api";

type Spec = Record<string, unknown> & { type: string };

const FORMATS = [
  { key: "csv-safe", label: "CSV — spreadsheet-safe", hint: "Cells starting with = + - @ are prefixed with an apostrophe to block formula injection. Opens safely in Excel." },
  { key: "jsonl", label: "JSONL — exact values", hint: "One JSON object per line with every value exactly as archived. Best for evidence and re-processing." },
  { key: "csv-raw", label: "CSV — raw", hint: "Values unchanged. Do not open in a spreadsheet application unless you trust the content." },
] as const;

/** Export dialog → short-lived signed link (5 min) → browser download. Every export is audit-logged. */
export function ExportButton({ spec, label = "Export", size = "sm", variant = "outline", formats = true, disabled }: { spec: Spec; label?: string; size?: "sm" | "default"; variant?: "outline" | "default" | "secondary"; formats?: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [fmt, setFmt] = useState<(typeof FORMATS)[number]["key"]>("csv-safe");
  const [busy, setBusy] = useState(false);

  const download = async (payload: Spec) => {
    setBusy(true);
    try {
      const r = await api<{ url: string }>("/api/v1/salesforce/exports", { body: payload });
      const a = document.createElement("a");
      a.href = r.url;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success("Download started — the export is logged in the archive audit trail.");
      setOpen(false);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!formats) {
    return (
      <Button size={size} variant={variant} disabled={disabled || busy} onClick={() => download(spec)}>
        {busy ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />} {label}
      </Button>
    );
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size={size} variant={variant} disabled={disabled}>
          <DownloadIcon /> {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export archived data</DialogTitle>
          <DialogDescription>The file is streamed from the archive. Exports contain client personal data — store them securely. Your download is recorded.</DialogDescription>
        </DialogHeader>
        <RadioGroup value={fmt} onValueChange={(v) => setFmt(v as typeof fmt)} className="gap-2">
          {FORMATS.map((f) => (
            <Label key={f.key} htmlFor={`fmt-${f.key}`} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal has-[[data-state=checked]]:border-primary/50 has-[[data-state=checked]]:bg-primary/5">
              <RadioGroupItem id={`fmt-${f.key}`} value={f.key} className="mt-0.5" />
              <span className="space-y-0.5">
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  {f.label}
                  {f.key === "csv-raw" && <ShieldAlertIcon className="size-3.5 text-warning" />}
                </span>
                <span className="block text-xs text-muted-foreground">{f.hint}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
        <p className="text-xs text-muted-foreground">Spreadsheet apps may drop leading zeros (e.g. 007421) when opening CSV — import columns as text, or use JSONL.</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => download({ ...spec, format: fmt === "jsonl" ? "jsonl" : "csv", safe: fmt !== "csv-raw" })}>
            {busy ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />} Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
