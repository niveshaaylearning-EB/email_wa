"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2Icon, ShieldCheckIcon, ShieldOffIcon, TagsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CategoryMultiPicker, type CategoryOption } from "@/components/app/category-picker";
import { api, errorMessage } from "@/lib/client/api";

export function ClientActions({
  clientId,
  email,
  phone,
  categories,
  memberCategoryIds,
  canSuppress,
}: {
  clientId: string;
  email: string | null;
  phone: string | null;
  categories: CategoryOption[];
  memberCategoryIds: string[];
  canSuppress: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<null | "categories" | "consent" | "suppress">(null);
  const [cats, setCats] = useState<string[]>(memberCategoryIds);
  const [channel, setChannel] = useState<"EMAIL" | "WHATSAPP">("WHATSAPP");
  const [status, setStatus] = useState<"GRANTED" | "REVOKED">("GRANTED");
  const [evidence, setEvidence] = useState("");
  const [supChannel, setSupChannel] = useState<"ALL" | "EMAIL" | "WHATSAPP">("ALL");
  const [supReason, setSupReason] = useState("MANUAL");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      setOpen(null);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveCategories = () =>
    run(async () => {
      const add = cats.filter((c) => !memberCategoryIds.includes(c));
      const remove = memberCategoryIds.filter((c) => !cats.includes(c));
      if (add.length) await api("/api/v1/memberships", { body: { clientIds: [clientId], categoryIds: add } });
      if (remove.length) await api("/api/v1/memberships/remove", { body: { clientIds: [clientId], categoryIds: remove } });
    }, "Categories updated");

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen("categories")}>
        <TagsIcon /> Categories
      </Button>
      <Button variant="outline" size="sm" onClick={() => setOpen("consent")}>
        <ShieldCheckIcon /> Record consent
      </Button>
      {canSuppress && (
        <Button variant="outline" size="sm" onClick={() => setOpen("suppress")} disabled={!email && !phone}>
          <ShieldOffIcon /> Suppress
        </Button>
      )}

      <Dialog open={open === "categories"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Category memberships</DialogTitle>
            <DialogDescription>A client may belong to any number of categories. Changes are recorded in membership history.</DialogDescription>
          </DialogHeader>
          <CategoryMultiPicker options={categories} value={cats} onChange={setCats} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            <Button onClick={saveCategories} disabled={busy}>
              {busy && <Loader2Icon className="animate-spin" />} Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open === "consent"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record consent decision</DialogTitle>
            <DialogDescription>Consent records are append-only. Record the evidence (how and when consent was given or withdrawn).</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Channel</Label>
                <RadioGroup value={channel} onValueChange={(v) => setChannel(v as typeof channel)}>
                  {(["WHATSAPP", "EMAIL"] as const).map((c) => (
                    <label key={c} className="flex items-center gap-2 text-sm">
                      <RadioGroupItem value={c} /> {c === "EMAIL" ? "Email" : "WhatsApp"}
                    </label>
                  ))}
                </RadioGroup>
              </div>
              <div className="space-y-2">
                <Label>Decision</Label>
                <RadioGroup value={status} onValueChange={(v) => setStatus(v as typeof status)}>
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="GRANTED" /> Granted (opt-in)
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="REVOKED" /> Revoked (opt-out)
                  </label>
                </RadioGroup>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="evidence">Evidence</Label>
              <Textarea id="evidence" rows={3} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="e.g. Client confirmed WhatsApp opt-in on call with advisory desk, 16 Oct 2026" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy || evidence.trim().length < 3}
              onClick={() => run(() => api("/api/v1/consents", { body: { clientId, channel, status, source: "MANUAL", evidence } }), "Consent recorded")}
            >
              {busy && <Loader2Icon className="animate-spin" />} Record
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={open === "suppress"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add to suppression list</DialogTitle>
            <DialogDescription>Suppressed identifiers are excluded from every future campaign until lifted.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Scope</Label>
              <Select value={supChannel} onValueChange={(v) => setSupChannel(v as typeof supChannel)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">All channels</SelectItem>
                  <SelectItem value="EMAIL">Email only</SelectItem>
                  <SelectItem value="WHATSAPP">WhatsApp only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Reason</Label>
              <Select value={supReason} onValueChange={setSupReason}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["MANUAL", "UNSUBSCRIBED", "DND", "COMPLAINT", "INVALID_CONTACT", "LEGAL_HOLD"].map((r) => (
                    <SelectItem key={r} value={r}>
                      {r.replace("_", " ").toLowerCase()}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const ch = supChannel === "ALL" ? null : supChannel;
                  if (email && supChannel !== "WHATSAPP") await api("/api/v1/suppressions", { body: { channel: ch, identifierType: "EMAIL", identifierValue: email, reason: supReason } });
                  if (phone && supChannel !== "EMAIL") await api("/api/v1/suppressions", { body: { channel: ch, identifierType: "PHONE", identifierValue: phone, reason: supReason } });
                }, "Suppression added")
              }
            >
              {busy && <Loader2Icon className="animate-spin" />} Suppress
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
