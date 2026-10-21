"use client";

import { useState } from "react";
import { ArchiveIcon, CodeIcon, GlobeIcon } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/**
 * Sandboxed iframe (no allow-scripts, no same-origin) over a sanitised preview endpoint.
 * "Archived images" renders with the copies held in the archive; "Live images" loads them from
 * Salesforce's CDN (may be tracking pixels, and stops working once the account closes).
 */
export function PreviewFrame({ src, height = 680 }: { src: string; height?: number }) {
  const [mode, setMode] = useState<"archived" | "remote" | "source">("archived");
  const url = `${src}?mode=${mode}`;
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <ToggleGroup type="single" size="sm" variant="outline" value={mode} onValueChange={(v) => v && setMode(v as typeof mode)}>
          <ToggleGroupItem value="archived" title="Images from the archive">
            <ArchiveIcon /> Archived images
          </ToggleGroupItem>
          <ToggleGroupItem value="remote" title="Images from Salesforce's live CDN — may be tracking pixels">
            <GlobeIcon /> Live images
          </ToggleGroupItem>
          <ToggleGroupItem value="source">
            <CodeIcon /> Original source
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <iframe key={url} title="Archived email preview" src={url} sandbox="" referrerPolicy="no-referrer" className="w-full bg-white" style={{ height }} />
    </div>
  );
}
