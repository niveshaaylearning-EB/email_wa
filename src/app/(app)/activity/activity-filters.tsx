"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUrlParams } from "@/components/app/url-controls";

const TYPES = ["campaign", "category", "category_rule", "client", "template", "integration", "sync_run", "suppression", "user", "settings", "test_recipient"];

export function ActivityFilters() {
  const { params, set } = useUrlParams();
  return (
    <Select value={params.get("entityType") ?? "__all"} onValueChange={(v) => set({ entityType: v === "__all" ? null : v })}>
      <SelectTrigger className="h-9 w-full bg-surface sm:w-52">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all">All entities</SelectItem>
        {TYPES.map((t) => (
          <SelectItem key={t} value={t}>
            {t.replace("_", " ")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
