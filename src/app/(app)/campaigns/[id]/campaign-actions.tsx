"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BanIcon, CopyIcon, DownloadIcon, PauseIcon, PencilIcon, PlayIcon, Trash2Icon, Undo2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { api, errorMessage } from "@/lib/client/api";

export function CampaignActions({ id, status, canWrite, canExecute, isCreator, hasReport }: { id: string; status: string; canWrite: boolean; canExecute: boolean; isCreator: boolean; hasReport: boolean }) {
  const router = useRouter();
  const call = async (path: string, body?: unknown, msg?: string) => {
    try {
      await api(`/api/v1/campaigns/${id}/${path}`, { method: "POST", body });
      if (msg) toast.success(msg);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
  };
  const editable = ["DRAFT", "REJECTED"].includes(status);
  const cancellable = ["PENDING_APPROVAL", "APPROVED", "SCHEDULED", "QUEUED", "RUNNING", "PAUSED", "DRAFT", "REJECTED"].includes(status);
  return (
    <>
      {canWrite && editable && (
        <Button asChild variant="outline" size="sm">
          <Link href={`/campaigns/${id}/edit`}>
            <PencilIcon /> Edit
          </Link>
        </Button>
      )}
      {canWrite && status === "PENDING_APPROVAL" && isCreator && (
        <Button variant="outline" size="sm" onClick={() => call("withdraw", undefined, "Submission withdrawn").catch(() => undefined)}>
          <Undo2Icon /> Withdraw
        </Button>
      )}
      {canExecute && ["QUEUED", "RUNNING", "SCHEDULED"].includes(status) && (
        <Button variant="outline" size="sm" onClick={() => call("pause", undefined, "Campaign paused").catch(() => undefined)}>
          <PauseIcon /> Pause
        </Button>
      )}
      {canExecute && status === "PAUSED" && (
        <ConfirmDialog
          trigger={
            <Button size="sm">
              <PlayIcon /> Resume
            </Button>
          }
          title="Resume sending?"
          description="Remaining queued messages will be sent using the frozen audience and templates."
          confirmLabel="Resume"
          onConfirm={() => call("resume", undefined, "Campaign resumed")}
        />
      )}
      {hasReport && (
        <Button asChild variant="outline" size="sm">
          <a href={`/api/v1/campaigns/${id}/report`}>
            <DownloadIcon /> Export report
          </a>
        </Button>
      )}
      {canWrite && (
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            try {
              const c = await api<{ id: string }>(`/api/v1/campaigns/${id}/duplicate`, { method: "POST" });
              toast.success("Copied to a new draft");
              router.push(`/campaigns/${c.id}/edit`);
            } catch (e) {
              toast.error(errorMessage(e));
            }
          }}
        >
          <CopyIcon /> Duplicate
        </Button>
      )}
      {canWrite && editable && (
        <ConfirmDialog
          trigger={
            <Button variant="ghost" size="sm">
              <Trash2Icon /> Delete draft
            </Button>
          }
          title="Delete this draft?"
          description="The draft is hidden from lists. Its audit trail is kept."
          destructive
          confirmLabel="Delete"
          onConfirm={async () => {
            try {
              await api(`/api/v1/campaigns/${id}`, { method: "DELETE" });
              router.push("/campaigns");
            } catch (e) {
              toast.error(errorMessage(e));
              throw e;
            }
          }}
        />
      )}
      {canExecute && cancellable && !editable && (
        <ConfirmDialog
          trigger={
            <Button variant="destructive" size="sm">
              <BanIcon /> Cancel campaign
            </Button>
          }
          title="Cancel this campaign?"
          description="Messages not yet handed to a provider are cancelled. Messages already accepted by a provider cannot be recalled. This cannot be undone."
          destructive
          confirmLabel="Cancel campaign"
          reason={{ label: "Reason (recorded in the audit log)", minLength: 3 }}
          onConfirm={(reason) => call("cancel", { reason }, "Campaign cancelled")}
        />
      )}
    </>
  );
}
