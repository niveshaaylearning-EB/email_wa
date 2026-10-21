"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeftIcon, ChevronRightIcon, Loader2Icon, SearchIcon, XIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function useUrlParams() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const set = (patch: Record<string, string | null | undefined>, opts: { resetPage?: boolean } = { resetPage: true }) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (opts.resetPage && !("page" in patch)) next.delete("page");
    startTransition(() => router.replace(`${pathname}${next.toString() ? `?${next}` : ""}`, { scroll: false }));
  };
  return { params, set, pending };
}

export function UrlSearch({ placeholder = "Search…", param = "q", className }: { placeholder?: string; param?: string; className?: string }) {
  const { params, set, pending } = useUrlParams();
  const [value, setValue] = useState(params.get(param) ?? "");
  useEffect(() => {
    const t = setTimeout(() => {
      if ((params.get(param) ?? "") !== value) set({ [param]: value.trim() || null });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <div className={cn("relative w-full sm:max-w-xs", className)}>
      <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} className="h-9 bg-surface pl-8 pr-8" aria-label={placeholder} />
      {pending ? (
        <Loader2Icon className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
      ) : value ? (
        <button aria-label="Clear search" onClick={() => setValue("")} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground">
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

export function UrlPagination({ total, page, pageSize }: { total: number; page: number; pageSize: number }) {
  const { set, pending } = useUrlParams();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 px-1 py-3 text-sm text-muted-foreground">
      <span className="tabular">
        {from.toLocaleString("en-IN")}–{to.toLocaleString("en-IN")} of {total.toLocaleString("en-IN")}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="icon-sm" disabled={page <= 1 || pending} onClick={() => set({ page: String(page - 1) }, { resetPage: false })} aria-label="Previous page">
          <ChevronLeftIcon />
        </Button>
        <span className="tabular px-2">
          Page {page} / {pages}
        </span>
        <Button variant="outline" size="icon-sm" disabled={page >= pages || pending} onClick={() => set({ page: String(page + 1) }, { resetPage: false })} aria-label="Next page">
          <ChevronRightIcon />
        </Button>
      </div>
    </div>
  );
}
