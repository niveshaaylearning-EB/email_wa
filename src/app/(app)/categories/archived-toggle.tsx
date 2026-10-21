"use client";

import { Switch } from "@/components/ui/switch";
import { useUrlParams } from "@/components/app/url-controls";

export function ArchivedToggle({ checked }: { checked: boolean }) {
  const { set } = useUrlParams();
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      <Switch checked={checked} onCheckedChange={(v) => set({ archived: v ? "1" : null })} />
      Show archived
    </label>
  );
}
