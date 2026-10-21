"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardCheckIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/client/api";

/** Record the count shown in the Salesforce UI — the independent source count the API cannot provide. */
export function AttestForm({ dataExtensionId }: { dataExtensionId: string }) {
  const router = useRouter();
  const [count, setCount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
        <div className="space-y-1.5">
          <Label className="text-[13px]">Record count in UI</Label>
          <Input inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))} placeholder="e.g. 18000" />
        </div>
        <div className="space-y-1.5">
          <Label className="text-[13px]">Where / when it was read</Label>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Contact Builder → Data Extensions → Records tab, 16 Oct 2026 14:05 IST, screenshot saved as …" />
        </div>
      </div>
      <Button
        size="sm"
        disabled={!count || note.trim().length < 5 || busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api<{ status: string | null }>(`/api/v1/salesforce/data-extensions/${dataExtensionId}/attest`, { body: { count: Number(count), note } });
            toast.success(`Attestation recorded${r.status ? ` · verification ${r.status.replace(/_/g, " ").toLowerCase()}` : ""}`);
            setCount("");
            setNote("");
            router.refresh();
          } catch (e) {
            toast.error(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2Icon className="animate-spin" /> : <ClipboardCheckIcon />} Attest source count
      </Button>
    </div>
  );
}
