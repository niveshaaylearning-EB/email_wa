"use client";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUrlParams } from "@/components/app/url-controls";

const TABS: [string, string][] = [
  ["all", "All"],
  ["drafts", "Drafts"],
  ["approval", "Awaiting approval"],
  ["active", "Active"],
  ["done", "Finished"],
];

export function StatusTabs({ value, counts }: { value: string; counts: Record<string, number> }) {
  const { set } = useUrlParams();
  return (
    <Tabs value={value} onValueChange={(v) => set({ tab: v === "all" ? null : v })}>
      <TabsList className="overflow-x-auto">
        {TABS.map(([k, l]) => (
          <TabsTrigger key={k} value={k} className="px-3">
            {l}
            {k !== "all" && counts[k] ? <span className="tabular ml-1 text-xs text-muted-foreground">{counts[k]}</span> : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
