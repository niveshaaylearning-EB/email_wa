"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2Icon, Loader2Icon, PlusIcon, RadarIcon, SaveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/app/empty-state";
import { Pill } from "@/components/app/status";
import { api, errorMessage } from "@/lib/client/api";

interface BU {
  mid: string;
  name: string;
  selected: boolean;
  isEnterprise: boolean;
  parentMid: string | null;
  source: string;
}

export function BusinessUnits({ connectionId, units, canManage }: { connectionId: string; units: BU[]; canManage: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState(new Set(units.filter((u) => u.selected).map((u) => u.mid)));
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState({ mid: "", name: "" });
  const call = async (key: string, body: unknown, ok: string | ((r: unknown) => string)) => {
    setBusy(key);
    try {
      const r = await api(`/api/v1/salesforce/connections/${connectionId}/business-units`, { body });
      toast.success(typeof ok === "function" ? ok(r) : ok);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const dirty = units.some((u) => u.selected !== selected.has(u.mid));

  return (
    <div className="space-y-3">
      {canManage && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!!busy} onClick={() => call("discover", { action: "discover" }, (r) => {
            const x = r as { count: number; method: string; warning?: string };
            if (x.warning) toast.warning(x.warning);
            return `${x.count} business unit(s) found via ${x.method}`;
          })}>
            {busy === "discover" ? <Loader2Icon className="animate-spin" /> : <RadarIcon />} Discover business units
          </Button>
          {dirty && (
            <Button size="sm" disabled={!!busy} onClick={() => call("select", { action: "select", mids: [...selected] }, "Selection saved")}>
              {busy === "select" ? <Loader2Icon className="animate-spin" /> : <SaveIcon />} Save selection
            </Button>
          )}
        </div>
      )}
      {units.length ? (
        <ul className="divide-y rounded-lg border">
          {units.map((u) => (
            <li key={u.mid} className="flex items-center gap-3 px-3 py-2.5">
              <Checkbox
                checked={selected.has(u.mid)}
                disabled={!canManage}
                onCheckedChange={(v) => setSelected((s) => {
                  const n = new Set(s);
                  if (v) n.add(u.mid);
                  else n.delete(u.mid);
                  return n;
                })}
                aria-label={`Include ${u.name} in backups`}
              />
              <Building2Icon className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{u.name}</p>
                <p className="font-mono text-xs text-muted-foreground">MID {u.mid}{u.parentMid ? ` · parent ${u.parentMid}` : ""}</p>
              </div>
              {u.isEnterprise && <Pill tone="brand">Enterprise</Pill>}
              <Pill tone="muted">{u.source}</Pill>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState compact icon={Building2Icon} title="No business units discovered" description="Run discovery after a successful connection test." />
      )}
      {canManage && (
        <div className="flex flex-wrap items-end gap-2">
          <Input className="w-36" placeholder="MID" inputMode="numeric" value={manual.mid} onChange={(e) => setManual((m) => ({ ...m, mid: e.target.value.replace(/\D/g, "") }))} />
          <Input className="w-56" placeholder="Name" value={manual.name} onChange={(e) => setManual((m) => ({ ...m, name: e.target.value }))} />
          <Button size="sm" variant="ghost" disabled={!manual.mid || !manual.name || !!busy} onClick={() => call("add", { action: "add", ...manual }, "Business unit added").then(() => setManual({ mid: "", name: "" }))}>
            <PlusIcon /> Add manually
          </Button>
        </div>
      )}
    </div>
  );
}
