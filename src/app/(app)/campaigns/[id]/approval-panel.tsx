"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertTriangleIcon, CheckIcon, Loader2Icon, ShieldAlertIcon, XIcon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Notice } from "@/components/app/empty-state";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { api, errorMessage } from "@/lib/client/api";
import type { AudienceSummary } from "@/lib/domain/eligibility";

export function ApprovalPanel({
  campaignId,
  canApprove,
  isOwn,
  isApprover,
  summary,
  validation,
  wouldBeLive,
}: {
  campaignId: string;
  canApprove: boolean;
  isOwn: boolean;
  isApprover: boolean;
  summary: AudienceSummary;
  validation: { errors: string[]; warnings: string[] };
  wouldBeLive: boolean;
}) {
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState("");
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = summary.messageVolume;
  const typedOk = typed.replace(/[,\s]/g, "") === String(count);
  const blocked = validation.errors.length > 0;

  return (
    <Card className="border-warning/40 ring-warning/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlertIcon className="size-4 text-warning" /> Approval required
        </CardTitle>
        <CardDescription>
          Current audience: <strong className="text-foreground">{count.toLocaleString("en-IN")}</strong> messages to <strong className="text-foreground">{summary.eligibleRecipients.toLocaleString("en-IN")}</strong> clients (
          {summary.perChannel.EMAIL.planned.toLocaleString("en-IN")} email · {summary.perChannel.WHATSAPP.planned.toLocaleString("en-IN")} WhatsApp). The audience is re-calculated and frozen when you approve.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {validation.errors.map((e) => (
          <Notice key={e} tone="danger" icon={AlertTriangleIcon}>
            {e}
          </Notice>
        ))}
        {validation.warnings.map((w) => (
          <Notice key={w} tone="warning">
            {w}
          </Notice>
        ))}
        {!isApprover ? (
          <p className="text-sm text-muted-foreground">Waiting for a user with the Approver role.</p>
        ) : isOwn ? (
          <Notice tone="info" title="Maker-checker">You created or submitted this campaign, so another approver must review it.</Notice>
        ) : (
          canApprove && (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="approve-count">
                  Type the message count <span className="tabular font-mono font-semibold">{count}</span> to confirm
                </Label>
                <Input id="approve-count" value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" autoComplete="off" inputMode="numeric" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="approve-note">Approval note (optional)</Label>
                <Textarea id="approve-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Content reviewed by compliance" />
              </div>
              {wouldBeLive && (
                <label className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm md:col-span-2">
                  <Checkbox checked={live} onCheckedChange={(v) => setLive(!!v)} className="mt-0.5" />
                  <span>
                    <strong className="text-destructive">Live send.</strong> I confirm this will send REAL messages to {summary.eligibleRecipients.toLocaleString("en-IN")} clients and that content, consent and compliance have been reviewed.
                  </span>
                </label>
              )}
              <div className="flex flex-wrap gap-2 md:col-span-2">
                <Button
                  disabled={!typedOk || blocked || busy || (wouldBeLive && !live)}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api(`/api/v1/campaigns/${campaignId}/approve`, { body: { confirmMessageCount: count, confirmLive: live, note: note || undefined } });
                      toast.success("Approved — audience frozen and campaign queued");
                      router.refresh();
                    } catch (e) {
                      toast.error(errorMessage(e));
                      router.refresh();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? <Loader2Icon className="animate-spin" /> : <CheckIcon />} Approve & freeze audience
                </Button>
                <ConfirmDialog
                  trigger={
                    <Button variant="outline">
                      <XIcon /> Reject
                    </Button>
                  }
                  title="Reject campaign"
                  description="The creator will see your reason and can revise the campaign."
                  confirmLabel="Reject"
                  destructive
                  reason={{ label: "Reason for rejection", minLength: 5, placeholder: "What needs to change?" }}
                  onConfirm={async (reason) => {
                    try {
                      await api(`/api/v1/campaigns/${campaignId}/reject`, { body: { reason } });
                      toast.success("Campaign rejected");
                      router.refresh();
                    } catch (e) {
                      toast.error(errorMessage(e));
                      throw e;
                    }
                  }}
                />
              </div>
            </div>
          )
        )}
      </CardContent>
    </Card>
  );
}
