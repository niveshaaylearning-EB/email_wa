"use client";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useUrlParams } from "@/components/app/url-controls";

export function RangePicker({ days }: { days: number }) {
  const { set } = useUrlParams();
  return (
    <ToggleGroup type="single" variant="outline" size="sm" value={String(days)} onValueChange={(v) => v && set({ days: v === "30" ? null : v })}>
      {[
        ["7", "7 days"],
        ["30", "30 days"],
        ["90", "90 days"],
        ["365", "12 months"],
      ].map(([v, l]) => (
        <ToggleGroupItem key={v} value={v} className="px-3">
          {l}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
