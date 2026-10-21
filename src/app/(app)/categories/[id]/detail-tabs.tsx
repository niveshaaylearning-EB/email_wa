"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  CheckCircle2Icon,
  FileUpIcon,
  Loader2Icon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  SparklesIcon,
  Trash2Icon,
  UserMinusIcon,
  UserPlusIcon,
  UsersIcon,
  XIcon,
  StarIcon,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { UrlPagination, UrlSearch } from "@/components/app/url-controls";
import { CampaignStatusBadge, ChannelBadge, Pill } from "@/components/app/status";
import { EmptyState, Notice } from "@/components/app/empty-state";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { api, errorMessage } from "@/lib/client/api";
import { formatIST, formatDateIST, relativeTime } from "@/lib/time";
import { RULE_FIELDS, RULE_OPERATORS, type RuleCondition } from "@/lib/domain/rules";
import type { ClientRow } from "@/lib/services/clients";

interface Props {
  categoryId: string;
  canWrite: boolean;
  canMapTemplates: boolean;
  members: { total: number; page: number; pageSize: number; rows: ClientRow[] };
  rules: { id: string; name: string; isActive: boolean; autoRemove: boolean; description: string; lastEvaluatedAt: string | null; lastMatchCount: number | null }[];
  mappedTemplates: { id: string; name: string; channel: "EMAIL" | "WHATSAPP"; approvalStatus: string; isDefault: boolean; providerTemplateId: string | null }[];
  availableTemplates: { id: string; name: string; channel: "EMAIL" | "WHATSAPP"; approvalStatus: string }[];
  campaigns: { id: string; name: string; status: string; channelMode: string; createdAt: string; memberCountAtSnapshot: number | null }[];
  events: { id: string; action: string; source: string; note: string | null; createdAt: string; client: { id: string; fullName: string }; actor: string | null }[];
}

export function CategoryDetailTabs(p: Props) {
  return (
    <Tabs defaultValue="members">
      <TabsList variant="line" className="w-full justify-start overflow-x-auto border-b">
        <TabsTrigger value="members">Members</TabsTrigger>
        <TabsTrigger value="import">CSV import</TabsTrigger>
        <TabsTrigger value="rules">Dynamic rules</TabsTrigger>
        <TabsTrigger value="templates">Templates ({p.mappedTemplates.length})</TabsTrigger>
        <TabsTrigger value="campaigns">Campaigns ({p.campaigns.length})</TabsTrigger>
        <TabsTrigger value="history">Change history</TabsTrigger>
      </TabsList>
      <TabsContent value="members" className="pt-4">
        <MembersTab {...p} />
      </TabsContent>
      <TabsContent value="import" className="pt-4">
        <ImportTab {...p} />
      </TabsContent>
      <TabsContent value="rules" className="pt-4">
        <RulesTab {...p} />
      </TabsContent>
      <TabsContent value="templates" className="pt-4">
        <TemplatesTab {...p} />
      </TabsContent>
      <TabsContent value="campaigns" className="pt-4">
        {p.campaigns.length ? (
          <div className="overflow-hidden rounded-xl border bg-card">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Campaign</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Members at approval</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {p.campaigns.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link className="font-medium hover:underline" href={`/campaigns/${c.id}`}>
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <ChannelBadge channel={c.channelMode} />
                    </TableCell>
                    <TableCell>
                      <CampaignStatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="tabular text-right">{c.memberCountAtSnapshot?.toLocaleString("en-IN") ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDateIST(c.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <EmptyState title="No campaigns have targeted this category yet" />
        )}
      </TabsContent>
      <TabsContent value="history" className="pt-4">
        {p.events.length ? (
          <ul className="divide-y rounded-xl border bg-card">
            {p.events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                <Pill tone={e.action === "ADDED" ? "success" : "muted"}>{e.action === "ADDED" ? "Added" : "Removed"}</Pill>
                <Link href={`/clients/${e.client.id}`} className="font-medium hover:underline">
                  {e.client.fullName}
                </Link>
                <span className="text-xs text-muted-foreground">
                  via {e.source.toLowerCase()} · {e.actor ?? "system"} · {formatIST(e.createdAt)}
                  {e.note ? ` · ${e.note}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No membership changes yet" />
        )}
      </TabsContent>
    </Tabs>
  );
}

function MembersTab({ categoryId, canWrite, members }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const remove = async (ids: string[]) => {
    try {
      const r = await api<{ removed: number }>("/api/v1/memberships/remove", { body: { clientIds: ids, categoryIds: [categoryId] } });
      toast.success(`Removed ${r.removed} member${r.removed === 1 ? "" : "s"}`);
      setSelected([]);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      throw e;
    }
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <UrlSearch placeholder="Search members" />
        {canWrite && selected.length > 0 && (
          <ConfirmDialog
            trigger={
              <Button variant="outline" size="sm">
                <UserMinusIcon /> Remove {selected.length}
              </Button>
            }
            title={`Remove ${selected.length} member(s)?`}
            description="They stay in Zoho CRM and in other categories. The change is recorded in history."
            confirmLabel="Remove"
            destructive
            onConfirm={() => remove(selected)}
          />
        )}
        {canWrite && <AddMembersDialog categoryId={categoryId} />}
      </div>
      {members.rows.length ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                {canWrite && (
                  <TableHead className="w-10">
                    <Checkbox
                      aria-label="Select all on page"
                      checked={selected.length > 0 && selected.length === members.rows.length}
                      onCheckedChange={(v) => setSelected(v ? members.rows.map((r) => r.id) : [])}
                    />
                  </TableHead>
                )}
                <TableHead>Client</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Mobile</TableHead>
                <TableHead>Other categories</TableHead>
                {canWrite && <TableHead className="w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {members.rows.map((m) => (
                <TableRow key={m.id}>
                  {canWrite && (
                    <TableCell>
                      <Checkbox checked={selected.includes(m.id)} onCheckedChange={(v) => setSelected((s) => (v ? [...s, m.id] : s.filter((x) => x !== m.id)))} aria-label={`Select ${m.fullName}`} />
                    </TableCell>
                  )}
                  <TableCell>
                    <Link href={`/clients/${m.id}`} className="font-medium hover:underline">
                      {m.fullName}
                    </Link>
                  </TableCell>
                  <TableCell className={m.emailValid ? "" : "text-muted-foreground"}>{m.email ?? "—"}</TableCell>
                  <TableCell className={m.phoneValid ? "tabular" : "text-destructive"}>{m.phoneValid ? m.phoneDisplay : m.phoneRaw ? "invalid" : "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{m.categories.filter((c) => c.id !== categoryId).map((c) => c.name).join(", ") || "—"}</TableCell>
                  {canWrite && (
                    <TableCell>
                      <ConfirmDialog
                        trigger={
                          <Button variant="ghost" size="icon-sm" aria-label={`Remove ${m.fullName}`}>
                            <XIcon />
                          </Button>
                        }
                        title={`Remove ${m.fullName}?`}
                        description="Only this category membership is removed."
                        confirmLabel="Remove"
                        destructive
                        onConfirm={() => remove([m.id])}
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="border-t px-3">
            <UrlPagination total={members.total} page={members.page} pageSize={members.pageSize} />
          </div>
        </div>
      ) : (
        <EmptyState icon={UsersIcon} title="No members yet" description="Add clients by search, from the Client Directory (bulk), by CSV, or with a dynamic rule." action={canWrite && <AddMembersDialog categoryId={categoryId} />} />
      )}
    </div>
  );
}

function AddMembersDialog({ categoryId }: { categoryId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ClientRow[]>([]);
  const [picked, setPicked] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const search = async () => {
    const r = await api<{ rows: ClientRow[] }>("/api/v1/clients", { query: { q, pageSize: 25 } });
    setResults(r.rows);
  };
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ added: number; alreadyMember: number }>("/api/v1/memberships", { body: { clientIds: [...picked.keys()], categoryIds: [categoryId] } });
      toast.success(`Added ${r.added}${r.alreadyMember ? ` (${r.alreadyMember} already members)` : ""}`);
      setOpen(false);
      setPicked(new Map());
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="ml-auto">
          <UserPlusIcon /> Add clients
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add clients</DialogTitle>
          <DialogDescription>Search CRM clients by name, email, phone or CRM ID. For large groups, use bulk selection in the Client Directory or CSV import.</DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search clients" autoFocus />
          <Button type="submit" variant="outline">
            <SearchIcon /> Search
          </Button>
        </form>
        <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border">
          {results.map((r) => {
            const member = r.categories.some((c) => c.id === categoryId);
            return (
              <li key={r.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50">
                  <Checkbox
                    disabled={member}
                    checked={member || picked.has(r.id)}
                    onCheckedChange={(v) =>
                      setPicked((m) => {
                        const n = new Map(m);
                        if (v) n.set(r.id, r.fullName);
                        else n.delete(r.id);
                        return n;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{r.fullName}</span>
                    <span className="block truncate text-xs text-muted-foreground">{r.email ?? r.phoneDisplay ?? r.zohoCrmId}</span>
                  </span>
                  {member && <Pill tone="muted">Member</Pill>}
                </label>
              </li>
            );
          })}
          {!results.length && <li className="px-3 py-6 text-center text-sm text-muted-foreground">Search to find clients</li>}
        </ul>
        <DialogFooter>
          <span className="mr-auto self-center text-sm text-muted-foreground">{picked.size} selected</span>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!picked.size || busy}>
            {busy && <Loader2Icon className="animate-spin" />} Add {picked.size || ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ImportResult {
  summary: { total: number; matched: number; alreadyMember: number; notFound: number; ambiguous: number; invalid: number };
  rows: { line: number; input: string; status: string; clientName?: string; message?: string }[];
  applied: boolean;
}

function ImportTab({ categoryId, canWrite }: Props) {
  const router = useRouter();
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await api<ImportResult>(`/api/v1/categories/${categoryId}/import`, { body: { csv, dryRun } });
      setResult(r);
      if (!dryRun) {
        toast.success(`Imported ${r.summary.matched} new member(s)`);
        router.refresh();
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (!canWrite) return <Notice tone="info">You don’t have permission to import memberships.</Notice>;
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Upload CSV</CardTitle>
          <CardDescription className="text-xs">
            Header row required. Identify clients with any of <code className="rounded bg-muted px-1">zoho_crm_id</code>, <code className="rounded bg-muted px-1">email</code> or <code className="rounded bg-muted px-1">phone</code>. Only existing CRM clients are matched — CSV never creates clients.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground hover:bg-muted/40">
            <FileUpIcon className="size-5" />
            {fileName ?? "Choose a .csv file (max 50,000 rows)"}
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (f.size > 5_000_000) return toast.error("File exceeds 5 MB");
                setFileName(f.name);
                setCsv(await f.text());
                setResult(null);
              }}
            />
          </label>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">…or paste CSV</summary>
            <Textarea className="mt-2 font-mono text-xs" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"email,phone\nasha@example.com,\n,9876543210"} />
          </details>
          <div className="flex gap-2">
            <Button variant="outline" disabled={!csv || busy} onClick={() => run(true)}>
              {busy ? <Loader2Icon className="animate-spin" /> : <CheckCircle2Icon />} Validate
            </Button>
            <Button disabled={!result || result.applied || !result.summary.matched || busy} onClick={() => run(false)}>
              Import {result?.summary.matched ?? ""} member(s)
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Validation result</CardTitle>
          <CardDescription className="text-xs">Nothing changes until you click Import.</CardDescription>
        </CardHeader>
        <CardContent>
          {result ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1.5">
                <Pill tone="success">{result.summary.matched} to add</Pill>
                <Pill tone="muted">{result.summary.alreadyMember} already members</Pill>
                <Pill tone="warning">{result.summary.notFound} not found</Pill>
                <Pill tone="warning">{result.summary.ambiguous} ambiguous</Pill>
                <Pill tone="danger">{result.summary.invalid} invalid</Pill>
              </div>
              {result.applied && <Notice tone="success" title="Import applied">Memberships were added and recorded in history.</Notice>}
              <div className="max-h-80 overflow-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 text-left">Line</th>
                      <th className="px-2 py-1.5 text-left">Input</th>
                      <th className="px-2 py-1.5 text-left">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((r) => (
                      <tr key={r.line} className="border-t">
                        <td className="tabular px-2 py-1">{r.line}</td>
                        <td className="max-w-48 truncate px-2 py-1 font-mono">{r.input}</td>
                        <td className="px-2 py-1">{r.status === "matched" ? <span className="text-success">→ {r.clientName}</span> : r.status === "already_member" ? <span className="text-muted-foreground">already member ({r.clientName})</span> : <span className="text-warning">{r.message}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Upload and validate a file to see row-level results.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const emptyCondition = (): RuleCondition => ({ field: "crmStatus", op: "equals", value: "" });

function RulesTab({ categoryId, canWrite, rules }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [match, setMatch] = useState<"all" | "any">("all");
  const [conditions, setConditions] = useState<RuleCondition[]>([emptyCondition()]);
  const [autoRemove, setAutoRemove] = useState(false);
  const [preview, setPreview] = useState<{ count: number; sample: { id: string; fullName: string }[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const definition = { match, conditions: conditions.map((c) => ({ ...c, value: c.op === "in" && typeof c.value === "string" ? c.value.split(",").map((s) => s.trim()).filter(Boolean) : c.value })) };

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const needsValue = (op: string) => !["is_empty", "is_not_empty", "is_true", "is_false"].includes(op);

  return (
    <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Rules</CardTitle>
          <CardDescription className="text-xs">Rules run after every CRM sync and on demand. They only add/remove memberships they created — manual, bulk and CSV members are never touched.</CardDescription>
        </CardHeader>
        <CardContent>
          {rules.length ? (
            <ul className="divide-y">
              {rules.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <SparklesIcon className="size-3.5 text-primary" /> {r.name}
                      {r.autoRemove && <Pill tone="info">auto-remove</Pill>}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{r.description}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {r.lastEvaluatedAt ? `Last run ${relativeTime(r.lastEvaluatedAt)} · ${r.lastMatchCount ?? 0} matches` : "Not evaluated yet"}
                    </p>
                  </div>
                  {canWrite && (
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === r.id}
                        onClick={() =>
                          act(r.id, async () => {
                            const res = await api<{ added: number; removed: number; matched: number }>(`/api/v1/rules/${r.id}/evaluate`, { method: "POST" });
                            toast.success(`Rule run: ${res.matched} match, ${res.added} added, ${res.removed} removed`);
                            router.refresh();
                          })
                        }
                      >
                        {busy === r.id ? <Loader2Icon className="animate-spin" /> : <PlayIcon />} Run now
                      </Button>
                      <ConfirmDialog
                        trigger={
                          <Button size="icon-sm" variant="ghost" aria-label="Archive rule">
                            <Trash2Icon />
                          </Button>
                        }
                        title="Archive this rule?"
                        description="Existing memberships created by the rule are kept. It will stop running."
                        confirmLabel="Archive rule"
                        destructive
                        onConfirm={async () => {
                          await api(`/api/v1/rules/${r.id}`, { method: "DELETE" });
                          toast.success("Rule archived");
                          router.refresh();
                        }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact icon={SparklesIcon} title="No dynamic rules" description="Create a rule to keep this category in sync with CRM attributes." />
          )}
        </CardContent>
      </Card>
      {canWrite && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">New rule</CardTitle>
            <CardDescription className="text-xs">Evaluated against mirrored CRM fields.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="rule-name">Name</Label>
              <Input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Renewal due in CRM" />
            </div>
            <div className="flex items-center gap-2 text-sm">
              Match
              <Select value={match} onValueChange={(v) => setMatch(v as "all" | "any")}>
                <SelectTrigger size="sm" className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">all</SelectItem>
                  <SelectItem value="any">any</SelectItem>
                </SelectContent>
              </Select>
              of these conditions
            </div>
            {conditions.map((c, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-2 rounded-lg border p-2">
                <Select value={c.field} onValueChange={(v) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, field: v as RuleCondition["field"], op: v === "hasEmail" || v === "hasValidPhone" ? "is_true" : x.op } : x)))}>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(RULE_FIELDS).map(([k, l]) => (
                      <SelectItem key={k} value={k}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={c.op} onValueChange={(v) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, op: v as RuleCondition["op"] } : x)))}>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(RULE_OPERATORS)
                      .filter(([k]) => (c.field === "hasEmail" || c.field === "hasValidPhone" ? ["is_true", "is_false"].includes(k) : !["is_true", "is_false"].includes(k)))
                      .map(([k, l]) => (
                        <SelectItem key={k} value={k}>
                          {l}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <Button variant="ghost" size="icon-sm" aria-label="Remove condition" disabled={conditions.length === 1} onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))}>
                  <XIcon />
                </Button>
                {c.field === "crmField" && (
                  <Input className="col-span-3 h-8" placeholder="CRM field API name (e.g. Plan)" value={c.crmFieldKey ?? ""} onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, crmFieldKey: e.target.value } : x)))} />
                )}
                {needsValue(c.op) && (
                  <Input
                    className="col-span-3 h-8"
                    placeholder={c.op === "in" ? "Comma-separated values" : "Value"}
                    value={typeof c.value === "string" ? c.value : (c.value ?? []).join(", ")}
                    onChange={(e) => setConditions((cs) => cs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  />
                )}
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={() => setConditions((cs) => [...cs, emptyCondition()])}>
              <PlusIcon /> Add condition
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={autoRemove} onCheckedChange={setAutoRemove} />
              Remove rule members who stop matching
            </label>
            {preview && (
              <Notice tone="info" title={`${preview.count.toLocaleString("en-IN")} clients currently match`}>
                {preview.sample.map((s) => s.fullName).join(", ")}
                {preview.count > preview.sample.length ? "…" : ""}
              </Notice>
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={busy === "preview"}
                onClick={() =>
                  act("preview", async () => {
                    setPreview(await api("/api/v1/rules/preview", { body: { definition } }));
                  })
                }
              >
                Preview matches
              </Button>
              <Button
                disabled={!name.trim() || busy === "save"}
                onClick={() =>
                  act("save", async () => {
                    const rule = await api<{ id: string }>(`/api/v1/categories/${categoryId}/rules`, { body: { name, definition, autoRemove, isActive: true } });
                    const res = await api<{ added: number }>(`/api/v1/rules/${rule.id}/evaluate`, { method: "POST" });
                    toast.success(`Rule created — ${res.added} member(s) added`);
                    setName("");
                    setConditions([emptyCondition()]);
                    setPreview(null);
                    router.refresh();
                  })
                }
              >
                {busy === "save" && <Loader2Icon className="animate-spin" />} Save & run
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function TemplatesTab({ categoryId, canMapTemplates, mappedTemplates, availableTemplates }: Props) {
  const router = useRouter();
  const [templateId, setTemplateId] = useState<string>("");
  const unmapped = availableTemplates.filter((t) => !mappedTemplates.some((m) => m.id === t.id));
  const call = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast.success(msg);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div className="space-y-4">
      <Notice tone="info" title="Only mapped templates can be used for this category">
        Campaign Studio offers exactly these templates when this category is selected. The default per channel is pre-selected.
      </Notice>
      {canMapTemplates && (
        <div className="flex flex-wrap gap-2">
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger className="w-80 bg-surface">
              <SelectValue placeholder="Choose a template to authorise" />
            </SelectTrigger>
            <SelectContent>
              {unmapped.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.channel === "EMAIL" ? "Email" : "WhatsApp"} · {t.name}
                  {t.approvalStatus !== "APPROVED" && ` (${t.approvalStatus.toLowerCase()})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button disabled={!templateId} onClick={() => call(() => api("/api/v1/template-mappings", { body: { categoryId, templateId, isDefault: false } }).then(() => setTemplateId("")), "Template authorised for category")}>
            <PlusIcon /> Authorise template
          </Button>
        </div>
      )}
      {mappedTemplates.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {(["WHATSAPP", "EMAIL"] as const).map((ch) => (
            <Card key={ch} size="sm">
              <CardHeader>
                <CardTitle className="text-sm font-semibold">
                  <ChannelBadge channel={ch} />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="divide-y">
                  {mappedTemplates
                    .filter((t) => t.channel === ch)
                    .map((t) => (
                      <li key={t.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                        <div className="min-w-0">
                          <Link href={`/templates/${t.id}`} className="font-medium hover:underline">
                            {t.name}
                          </Link>
                          <p className="truncate font-mono text-xs text-muted-foreground">{t.providerTemplateId ?? "hosted content"}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {t.approvalStatus !== "APPROVED" && <Pill tone="warning">{t.approvalStatus.toLowerCase()}</Pill>}
                          {t.isDefault ? (
                            <Pill tone="brand">
                              <StarIcon className="size-3" /> Default
                            </Pill>
                          ) : (
                            canMapTemplates && (
                              <Button size="xs" variant="ghost" onClick={() => call(() => api("/api/v1/template-mappings", { body: { categoryId, templateId: t.id, isDefault: true } }), "Default template set")}>
                                Make default
                              </Button>
                            )
                          )}
                          {canMapTemplates && (
                            <Button size="icon-xs" variant="ghost" aria-label="Remove mapping" onClick={() => call(() => api("/api/v1/template-mappings/remove", { body: { categoryId, templateId: t.id } }), "Mapping removed")}>
                              <XIcon />
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  {!mappedTemplates.some((t) => t.channel === ch) && <li className="py-3 text-sm text-muted-foreground">No {ch === "EMAIL" ? "email" : "WhatsApp"} template mapped.</li>}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <EmptyState compact title="No templates mapped" description="Authorise at least one email or WhatsApp template so this category can be used in campaigns." />
      )}
    </div>
  );
}
