"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDownIcon, ChevronRightIcon, ChevronLeftIcon, Loader2Icon } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CategoryChip, ChannelBadge, DeliveryStatusBadge } from "@/components/app/status";
import { api } from "@/lib/client/api";
import { formatIST } from "@/lib/time";

interface Row {
  id: string;
  channel: string;
  status: string;
  isSimulated: boolean;
  providerMessageId: string | null;
  failureReason: string | null;
  client: { id: string; fullName: string };
  assignment: { category: { name: string; color: string }; template: { name: string } };
  events: { id: string; toStatus: string; source: string; occurredAt: string; detail: Record<string, unknown> | null }[];
}

export function RecipientTable({ campaignId }: { campaignId: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("__all");
  const [channel, setChannel] = useState("__all");
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const pageSize = 25;
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ total: number; rows: Row[] }>(`/api/v1/campaigns/${campaignId}/recipients`, {
        query: { page, pageSize, q: q || undefined, status: status === "__all" ? undefined : status, channel: channel === "__all" ? undefined : channel },
      });
      setRows(r.rows);
      setTotal(r.total);
    } finally {
      setLoading(false);
    }
  }, [campaignId, page, q, status, channel]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Recipients</CardTitle>
        <CardDescription className="text-xs">Per-recipient status and full event history. Expand a row for provider events.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search recipient" className="h-9 max-w-xs" />
          <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
            <SelectTrigger className="h-9 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All statuses</SelectItem>
              {["QUEUED", "SUBMITTED", "ACCEPTED", "SENT", "DELIVERED", "READ", "FAILED", "BOUNCED", "CANCELLED", "DRY_RUN"].map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replace("_", " ").toLowerCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={channel} onValueChange={(v) => { setChannel(v); setPage(1); }}>
            <SelectTrigger className="h-9 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">All channels</SelectItem>
              <SelectItem value="EMAIL">Email</SelectItem>
              <SelectItem value="WHATSAPP">WhatsApp</SelectItem>
            </SelectContent>
          </Select>
          {loading && <Loader2Icon className="size-4 animate-spin self-center text-muted-foreground" />}
        </div>
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Recipient</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Category / template</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Provider message ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <TableRow className="cursor-pointer" onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <TableCell>{open === r.id ? <ChevronDownIcon className="size-4" /> : <ChevronRightIcon className="size-4" />}</TableCell>
                    <TableCell>
                      <Link href={`/clients/${r.client.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:underline">
                        {r.client.fullName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <ChannelBadge channel={r.channel} />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <CategoryChip name={r.assignment.category.name} color={r.assignment.category.color} />
                        <span className="truncate text-xs text-muted-foreground">{r.assignment.template.name}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <DeliveryStatusBadge status={r.status} simulated={r.isSimulated} />
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{r.providerMessageId?.slice(0, 20) ?? "—"}</TableCell>
                  </TableRow>
                  {open === r.id && (
                    <TableRow className="bg-muted/30 hover:bg-muted/30">
                      <TableCell />
                      <TableCell colSpan={5}>
                        {r.failureReason && <p className="mb-2 text-xs text-destructive">{r.failureReason}</p>}
                        <ol className="space-y-1 text-xs">
                          {r.events.map((e) => (
                            <li key={e.id} className="grid grid-cols-[150px_110px_1fr] gap-2">
                              <span className="tabular text-muted-foreground">{formatIST(e.occurredAt, "dd MMM, hh:mm:ss a")}</span>
                              <span className="font-medium">{e.toStatus.toLowerCase()}</span>
                              <span className="truncate text-muted-foreground">
                                {e.source.toLowerCase().replace("_", " ")}
                                {e.detail && Object.keys(e.detail).length ? ` · ${JSON.stringify(e.detail)}` : ""}
                              </span>
                            </li>
                          ))}
                        </ol>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
              {!rows.length && !loading && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    No deliveries match.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span className="tabular">{total.toLocaleString("en-IN")} deliveries</span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Previous page">
              <ChevronLeftIcon />
            </Button>
            <span className="tabular px-2">
              {page} / {pages}
            </span>
            <Button variant="outline" size="icon-sm" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Next page">
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
