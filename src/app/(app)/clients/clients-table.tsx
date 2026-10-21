"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type RowSelectionState } from "@tanstack/react-table";
import { toast } from "sonner";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  DownloadIcon,
  FilterIcon,
  Loader2Icon,
  MinusCircleIcon,
  PlusCircleIcon,
  RefreshCwIcon,
  UsersIcon,
  XIcon,
  CopyIcon,
  FlaskConicalIcon,
} from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { UrlPagination, UrlSearch, useUrlParams } from "@/components/app/url-controls";
import { CategoryChip, Pill } from "@/components/app/status";
import { EmptyState } from "@/components/app/empty-state";
import { CategoryMultiPicker, type CategoryOption } from "@/components/app/category-picker";
import { api, errorMessage } from "@/lib/client/api";
import { formatDateIST } from "@/lib/time";
import type { ClientRow } from "@/lib/services/clients";
import type { ClientListQuery } from "@/lib/contracts";

interface Props {
  data: { total: number; page: number; pageSize: number; rows: ClientRow[] };
  query: ClientListQuery;
  categories: CategoryOption[];
  statuses: string[];
  canWrite: boolean;
  canSync: boolean;
}

const FILTER_LABELS: Record<string, string> = {
  missing_email: "Missing email",
  missing_phone: "Missing phone",
  invalid_phone: "Invalid phone",
  complete: "Email + valid phone",
  email_revoked: "Email unsubscribed",
  whatsapp_granted: "WhatsApp opted in",
  whatsapp_missing: "No WhatsApp consent",
};

export function ClientsTable({ data, query, categories, statuses, canWrite, canSync }: Props) {
  const router = useRouter();
  const { set, params } = useUrlParams();
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [allMatchingIds, setAllMatchingIds] = useState<string[] | null>(null);
  const [dialog, setDialog] = useState<null | "add" | "remove">(null);
  const [syncing, setSyncing] = useState(false);

  const selectedIds = allMatchingIds ?? Object.keys(selection).filter((k) => selection[k]);

  const sortBy = (key: ClientListQuery["sort"]) => set({ sort: key, dir: query.sort === key && query.dir === "asc" ? "desc" : "asc" });
  const SortHead = ({ k, children }: { k: ClientListQuery["sort"]; children: React.ReactNode }) => (
    <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => sortBy(k)}>
      {children}
      {query.sort === k ? query.dir === "asc" ? <ArrowUpIcon className="size-3" /> : <ArrowDownIcon className="size-3" /> : <ArrowUpDownIcon className="size-3 opacity-40" />}
    </button>
  );

  const columns = useMemo<ColumnDef<ClientRow>[]>(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            aria-label="Select page"
            checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? "indeterminate" : false}
            onCheckedChange={(v) => {
              setAllMatchingIds(null);
              table.toggleAllPageRowsSelected(!!v);
            }}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label={`Select ${row.original.fullName}`}
            checked={allMatchingIds ? true : row.getIsSelected()}
            onCheckedChange={(v) => {
              setAllMatchingIds(null);
              row.toggleSelected(!!v);
            }}
          />
        ),
      },
      {
        id: "name",
        header: () => <SortHead k="name">Client</SortHead>,
        cell: ({ row: { original: c } }) => (
          <div className="min-w-0">
            <Link href={`/clients/${c.id}`} className="font-medium hover:underline">
              {c.fullName}
            </Link>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-mono">{c.zohoCrmId}</span>
              {c.isMock && <FlaskConicalIcon className="size-3 text-warning" aria-label="Mock record" />}
              {(c.isDuplicate || c.hasDuplicates) && (
                <span className="inline-flex items-center gap-0.5 text-warning" title={c.isDuplicate ? "Duplicate of another CRM record" : "Has duplicate CRM records"}>
                  <CopyIcon className="size-3" /> dup
                </span>
              )}
              {c.deletedInCrm && <span className="text-destructive">deleted in CRM</span>}
            </div>
          </div>
        ),
      },
      {
        id: "email",
        header: () => <SortHead k="email">Email</SortHead>,
        cell: ({ row: { original: c } }) =>
          c.email ? <span className={c.emailValid ? "" : "text-destructive"}>{c.email}</span> : <span className="text-muted-foreground">—</span>,
      },
      {
        id: "phone",
        header: "Mobile",
        cell: ({ row: { original: c } }) =>
          c.phoneValid ? (
            <span className="tabular whitespace-nowrap">{c.phoneDisplay}</span>
          ) : c.phoneRaw ? (
            <span className="whitespace-nowrap text-destructive" title="Could not be normalised to E.164">
              {c.phoneRaw} <span className="text-xs">(invalid)</span>
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "categories",
        header: () => <SortHead k="categories">Categories</SortHead>,
        cell: ({ row: { original: c } }) =>
          c.categories.length ? (
            <div className="flex min-w-[220px] max-w-[380px] flex-wrap gap-1">
              {c.categories.slice(0, 3).map((cat) => (
                <CategoryChip key={cat.id} name={cat.name} color={cat.color} />
              ))}
              {c.categories.length > 3 && <span className="text-xs text-muted-foreground">+{c.categories.length - 3}</span>}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">Uncategorised</span>
          ),
      },
      {
        id: "consent",
        header: "Consent",
        cell: ({ row: { original: c } }) => (
          <div className="flex flex-wrap gap-1">
            {c.suppressed && <Pill tone="danger">Suppressed</Pill>}
            {c.emailConsent === "REVOKED" && <Pill tone="warning">Email opt-out</Pill>}
            {c.whatsappConsent === "GRANTED" ? <Pill tone="success">WA opt-in</Pill> : c.whatsappConsent === "REVOKED" ? <Pill tone="warning">WA opt-out</Pill> : <Pill tone="muted">No WA consent</Pill>}
          </div>
        ),
      },
      {
        id: "status",
        header: "CRM status",
        cell: ({ row: { original: c } }) => <span className="text-sm">{c.crmStatus ?? "—"}</span>,
      },
      {
        id: "updated",
        header: () => <SortHead k="updated">CRM updated</SortHead>,
        cell: ({ row: { original: c } }) => <span className="tabular whitespace-nowrap text-sm text-muted-foreground">{formatDateIST(c.crmModifiedAt)}</span>,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query.sort, query.dir, allMatchingIds],
  );

  const table = useReactTable({
    data: data.rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => r.id,
    state: { rowSelection: selection },
    onRowSelectionChange: setSelection,
    enableRowSelection: canWrite,
    manualPagination: true,
    manualSorting: true,
  });

  const activeFilters = (["categoryId", "contact", "consent", "status", "duplicates", "uncategorized"] as const).filter((k) => params.get(k));
  const pageAllSelected = data.rows.length > 0 && data.rows.every((r) => selection[r.id]);

  const selectAllMatching = async () => {
    const ids = await api<string[]>("/api/v1/clients/ids", { query: Object.fromEntries(params.entries()) });
    setAllMatchingIds(ids);
  };

  const exportCsv = () => {
    const qs = new URLSearchParams(params.toString());
    window.location.href = `/api/v1/clients/export?${qs}`;
  };

  const sync = async () => {
    setSyncing(true);
    try {
      const r = await api<{ queued: boolean; stats?: { fetched: number; created: number; updated: number } }>("/api/v1/sync/crm", { body: { full: false } });
      toast.success(r.queued ? "CRM sync queued" : `CRM sync complete — ${r.stats?.fetched ?? 0} fetched, ${r.stats?.created ?? 0} new, ${r.stats?.updated ?? 0} updated`);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <UrlSearch placeholder="Search name, email, phone or CRM ID" className="sm:max-w-sm" />
        <Select value={query.categoryId ?? (query.uncategorized ? "__none" : "__all")} onValueChange={(v) => set({ categoryId: v.startsWith("__") ? null : v, uncategorized: v === "__none" ? "1" : null })}>
          <SelectTrigger className="h-9 w-full bg-surface sm:w-52">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All categories</SelectItem>
            <SelectItem value="__none">Uncategorised</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                <span className="size-2 rounded-full" style={{ background: c.color }} /> {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FilterSheet statuses={statuses} activeCount={activeFilters.filter((f) => !["categoryId", "uncategorized"].includes(f)).length} />
        <div className="flex gap-2 sm:ml-auto">
          {canSync && (
            <Button variant="outline" size="sm" className="h-9" onClick={sync} disabled={syncing}>
              {syncing ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />} Sync CRM
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-9" onClick={exportCsv}>
            <DownloadIcon /> Export
          </Button>
        </div>
      </div>

      {activeFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {activeFilters.map((k) => {
            const v = params.get(k)!;
            const label = k === "categoryId" ? categories.find((c) => c.id === v)?.name ?? "Category" : k === "duplicates" ? "Duplicates" : k === "uncategorized" ? "Uncategorised" : k === "status" ? `Status: ${v}` : FILTER_LABELS[v] ?? v;
            return (
              <Badge key={k} variant="secondary" className="gap-1 pr-1">
                {label}
                <button aria-label={`Remove filter ${label}`} onClick={() => set({ [k]: null })} className="rounded p-0.5 hover:bg-foreground/10">
                  <XIcon className="size-3" />
                </button>
              </Badge>
            );
          })}
          <Button variant="link" size="xs" onClick={() => set({ categoryId: null, contact: null, consent: null, status: null, duplicates: null, uncategorized: null })}>
            Clear all
          </Button>
        </div>
      )}

      {canWrite && selectedIds.length > 0 && (
        <div className="sticky top-16 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-primary/25 bg-primary/5 px-3 py-2 text-sm backdrop-blur">
          <span className="font-medium">{selectedIds.length.toLocaleString("en-IN")} selected</span>
          {pageAllSelected && !allMatchingIds && data.total > data.rows.length && (
            <Button variant="link" size="sm" className="h-auto p-0" onClick={selectAllMatching}>
              Select all {data.total.toLocaleString("en-IN")} matching
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button size="sm" onClick={() => setDialog("add")}>
              <PlusCircleIcon /> Add to categories
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialog("remove")}>
              <MinusCircleIcon /> Remove from categories
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelection({});
                setAllMatchingIds(null);
              }}
            >
              Clear
            </Button>
          </div>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/50">
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="hover:bg-transparent">
                  {hg.headers.map((h) => (
                    <TableHead key={h.id} className="h-10 whitespace-nowrap text-xs font-medium text-muted-foreground first:w-10">
                      {flexRender(h.column.columnDef.header, h.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && "selected"}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="py-2.5 align-middle">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {data.rows.length === 0 && (
          <div className="p-6">
            <EmptyState icon={UsersIcon} title="No clients match" description="Try a different search or clear filters. Clients appear here after a Zoho CRM sync." />
          </div>
        )}
        <div className="border-t px-3">
          <UrlPagination total={data.total} page={data.page} pageSize={data.pageSize} />
        </div>
      </div>

      <MembershipDialog
        mode={dialog}
        onClose={() => setDialog(null)}
        clientIds={selectedIds}
        categories={categories}
        onDone={() => {
          setSelection({});
          setAllMatchingIds(null);
          router.refresh();
        }}
      />
    </div>
  );
}

function FilterSheet({ statuses, activeCount }: { statuses: string[]; activeCount: number }) {
  const { params, set } = useUrlParams();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string | null>>({});
  const val = (k: string) => (k in draft ? draft[k] : params.get(k)) ?? "__any";
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setDraft({});
      }}
    >
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 bg-surface">
          <FilterIcon /> Filters {activeCount > 0 && <Badge className="ml-0.5 h-4 min-w-4 px-1 text-[10px]">{activeCount}</Badge>}
        </Button>
      </SheetTrigger>
      <SheetContent className="sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>Filter clients</SheetTitle>
          <SheetDescription>Narrow the directory by contact quality, consent and CRM attributes.</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          <FilterOption val={val} setDraft={setDraft} k="contact" label="Contact details" options={[["complete", "Email + valid phone"], ["missing_email", "Missing email"], ["missing_phone", "Missing phone"], ["invalid_phone", "Invalid phone"]]} />
          <FilterOption val={val} setDraft={setDraft} k="consent" label="Consent" options={[["whatsapp_granted", "WhatsApp opted in"], ["whatsapp_missing", "No WhatsApp consent"], ["email_revoked", "Email unsubscribed"]]} />
          <FilterOption val={val} setDraft={setDraft} k="status" label="CRM status" options={statuses.map((s) => [s, s])} />
          <FilterOption val={val} setDraft={setDraft} k="duplicates" label="Duplicates" options={[["1", "Only duplicate identities"]]} />
        </div>
        <SheetFooter>
          <Button
            onClick={() => {
              set(draft);
              setOpen(false);
            }}
          >
            Apply filters
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              set({ contact: null, consent: null, status: null, duplicates: null });
              setOpen(false);
            }}
          >
            Reset
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function MembershipDialog({
  mode,
  onClose,
  clientIds,
  categories,
  onDone,
}: {
  mode: null | "add" | "remove";
  onClose: () => void;
  clientIds: string[];
  categories: CategoryOption[];
  onDone: () => void;
}) {
  const [cats, setCats] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      if (mode === "add") {
        const r = await api<{ added: number; alreadyMember: number }>("/api/v1/memberships", { body: { clientIds, categoryIds: cats, note: note || undefined } });
        toast.success(`Added ${r.added} membership${r.added === 1 ? "" : "s"}${r.alreadyMember ? ` (${r.alreadyMember} already members)` : ""}`);
      } else {
        const r = await api<{ removed: number }>("/api/v1/memberships/remove", { body: { clientIds, categoryIds: cats, note: note || undefined } });
        toast.success(`Removed ${r.removed} membership${r.removed === 1 ? "" : "s"}`);
      }
      setCats([]);
      setNote("");
      onClose();
      onDone();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={mode !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add to categories" : "Remove from categories"}</DialogTitle>
          <DialogDescription>
            {clientIds.length.toLocaleString("en-IN")} client{clientIds.length === 1 ? "" : "s"} selected. Clients can belong to any number of categories; existing memberships are kept.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Categories</Label>
            <CategoryMultiPicker options={categories} value={cats} onChange={setCats} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="membership-note">Note (optional, recorded in history)</Label>
            <Textarea id="membership-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Added after Q3 review call" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!cats.length || busy} variant={mode === "remove" ? "destructive" : "default"}>
            {busy && <Loader2Icon className="animate-spin" />}
            {mode === "add" ? "Add memberships" : "Remove memberships"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FilterOption({
  k,
  label,
  options,
  val,
  setDraft,
}: {
  k: string;
  label: string;
  options: [string, string][];
  val: (k: string) => string;
  setDraft: React.Dispatch<React.SetStateAction<Record<string, string | null>>>;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={val(k)} onValueChange={(v) => setDraft((d) => ({ ...d, [k]: v === "__any" ? null : v }))}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__any">Any</SelectItem>
          {options.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
