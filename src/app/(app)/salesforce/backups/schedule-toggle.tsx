"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { api, errorMessage } from "@/lib/client/api";

export function ScheduleToggle({ id, enabled }: { id: string; enabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Switch
      checked={enabled}
      disabled={busy}
      aria-label={enabled ? "Pause schedule" : "Enable schedule"}
      onCheckedChange={async (v) => {
        setBusy(true);
        try {
          await api(`/api/v1/salesforce/schedules/${id}`, { method: "PATCH", body: { enabled: v } });
          router.refresh();
        } catch (e) {
          toast.error(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
