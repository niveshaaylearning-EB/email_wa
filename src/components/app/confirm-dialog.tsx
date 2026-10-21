"use client";

import { useState } from "react";
import { Loader2Icon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";

/**
 * Confirmation dialog for consequential actions. Optional `typeToConfirm` requires the user to
 * type an exact phrase (used for large/live sends), and `reason` collects a mandatory note.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = "Confirm",
  destructive,
  typeToConfirm,
  reason,
  onConfirm,
  children,
  open: controlledOpen,
  onOpenChange,
}: {
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  typeToConfirm?: string;
  reason?: { label: string; placeholder?: string; minLength?: number };
  onConfirm: (reason: string) => Promise<unknown> | unknown;
  children?: React.ReactNode;
}) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (o: boolean) => {
    setInternalOpen(o);
    onOpenChange?.(o);
  };
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const blocked = (typeToConfirm !== undefined && typed.trim() !== typeToConfirm) || (reason && note.trim().length < (reason.minLength ?? 3));
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setTyped("");
          setNote("");
        }
      }}
    >
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription asChild><div className="space-y-2 text-sm text-muted-foreground">{description}</div></AlertDialogDescription>}
        </AlertDialogHeader>
        {children}
        {reason && (
          <div className="space-y-1.5">
            <Label htmlFor="confirm-reason">{reason.label}</Label>
            <Textarea id="confirm-reason" value={note} onChange={(e) => setNote(e.target.value)} placeholder={reason.placeholder} rows={3} />
          </div>
        )}
        {typeToConfirm !== undefined && (
          <div className="space-y-1.5">
            <Label htmlFor="confirm-type">
              Type <span className="font-mono font-semibold">{typeToConfirm}</span> to confirm
            </Label>
            <Input id="confirm-type" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="font-mono" />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={!!blocked || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm(note.trim());
                setOpen(false);
              } catch {
                // Caller surfaces the error (toast); keep the dialog open so the user can retry.
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Loader2Icon className="animate-spin" />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
