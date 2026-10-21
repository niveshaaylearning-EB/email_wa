"use client";

import { useState } from "react";

export function MetadataCell({ value }: { value: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  const keys = Object.keys(value ?? {});
  if (!keys.length) return <span className="text-xs text-muted-foreground">—</span>;
  const summary = keys
    .slice(0, 3)
    .map((k) => {
      const v = value[k];
      return `${k}: ${typeof v === "object" ? "…" : String(v)}`;
    })
    .join(" · ");
  return (
    <div className="text-xs">
      <button onClick={() => setOpen((o) => !o)} className="text-left text-muted-foreground hover:text-foreground">
        {open ? "Hide details" : summary}
      </button>
      {open && <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted p-2 text-[11px]">{JSON.stringify(value, null, 2)}</pre>}
    </div>
  );
}
