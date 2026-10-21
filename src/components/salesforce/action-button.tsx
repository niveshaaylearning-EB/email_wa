"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { BanIcon, FilePlus2Icon, LinkIcon, Loader2Icon, PlayIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { api, errorMessage } from "@/lib/client/api";

// Icons are referenced by name so server components can render this button (props must be serialisable).
const ICONS = { ban: BanIcon, play: PlayIcon, retry: RotateCcwIcon, link: LinkIcon, evidence: FilePlus2Icon, refresh: RefreshCwIcon } as const;
export type ActionIcon = keyof typeof ICONS;

/**
 * POST an archive action, toast the result and refresh server components. If the response
 * carries `message`, it is shown (as an error when `ok === false`); otherwise `success`.
 */
export function ActionButton({
  path,
  body,
  label,
  icon,
  variant = "outline",
  size = "sm",
  confirm,
  success,
  disabled,
}: {
  path: string;
  body?: unknown;
  label: string;
  icon?: ActionIcon;
  variant?: "outline" | "default" | "secondary" | "ghost" | "destructive";
  size?: "sm" | "default" | "xs";
  confirm?: { title: string; description: string; confirmLabel?: string; destructive?: boolean };
  success?: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const Icon = icon ? ICONS[icon] : null;
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{ message?: string; ok?: boolean } | null>(path, { method: "POST", body: body ?? {} });
      const message = r?.message ?? success;
      if (message) (r?.ok === false ? toast.error : toast.success)(message);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const button = (
    <Button variant={variant} size={size} disabled={disabled || busy} onClick={confirm ? undefined : run}>
      {busy ? <Loader2Icon className="animate-spin" /> : Icon ? <Icon /> : null}
      {label}
    </Button>
  );
  if (!confirm) return button;
  return <ConfirmDialog trigger={button} title={confirm.title} description={confirm.description} confirmLabel={confirm.confirmLabel ?? label} destructive={confirm.destructive} onConfirm={run} />;
}

/** Re-render server data every few seconds while a background job is active. */
export function LiveRefresh({ active, intervalMs = 4000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, router]);
  return active ? (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-info/60" />
        <span className="relative inline-flex size-2 rounded-full bg-info" />
      </span>
      Live
    </span>
  ) : null;
}
