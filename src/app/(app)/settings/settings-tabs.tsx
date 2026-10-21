"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2Icon, PlusIcon, SaveIcon, Trash2Icon, UserPlusIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Notice } from "@/components/app/empty-state";
import { Pill } from "@/components/app/status";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { api, errorMessage } from "@/lib/client/api";
import { formatIST, relativeTime } from "@/lib/time";
import type { AppSettings } from "@/lib/services/settings";

interface Props {
  settings: AppSettings;
  canEdit: boolean;
  canManageUsers: boolean;
  canSuppress: boolean;
  currentUserId: string;
  users: { id: string; name: string; email: string; role: string; isActive: boolean; lastLoginAt: string | null }[];
  roles: { key: string; label: string; description: string; permissions: string[] }[];
  testRecipients: { id: string; name: string; email: string | null; phoneE164: string | null }[];
  suppressions: { id: string; channel: string | null; identifierType: string; identifierValue: string; reason: string; source: string; createdAt: string; client: { id: string; fullName: string } | null }[];
}

export function SettingsTabs(p: Props) {
  return (
    <Tabs defaultValue="general">
      <TabsList variant="line" className="w-full justify-start overflow-x-auto border-b">
        <TabsTrigger value="general">Branding</TabsTrigger>
        <TabsTrigger value="compliance">Compliance & safety</TabsTrigger>
        {p.canManageUsers && <TabsTrigger value="users">Users & roles</TabsTrigger>}
        <TabsTrigger value="test">Test recipients</TabsTrigger>
        <TabsTrigger value="suppression">Suppression list</TabsTrigger>
      </TabsList>
      <TabsContent value="general" className="pt-4">
        <Branding {...p} />
      </TabsContent>
      <TabsContent value="compliance" className="pt-4">
        <Compliance {...p} />
      </TabsContent>
      {p.canManageUsers && (
        <TabsContent value="users" className="pt-4">
          <Users {...p} />
        </TabsContent>
      )}
      <TabsContent value="test" className="pt-4">
        <TestRecipients {...p} />
      </TabsContent>
      <TabsContent value="suppression" className="pt-4">
        <Suppression {...p} />
      </TabsContent>
    </Tabs>
  );
}

function useSave() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const save = async (patch: Partial<AppSettings>) => {
    setBusy(true);
    try {
      await api("/api/v1/settings", { method: "PATCH", body: patch });
      toast.success("Settings saved");
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return { save, busy };
}

function Branding({ settings, canEdit }: Props) {
  const [b, setB] = useState(settings.branding);
  const { save, busy } = useSave();
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Brand</CardTitle>
        <CardDescription className="text-xs">Colours apply to navigation, primary actions and accents in light and dark mode.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="product">Product name</Label>
          <Input id="product" value={b.productName} disabled={!canEdit} onChange={(e) => setB({ ...b, productName: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          {(["primaryColor", "accentColor"] as const).map((k) => (
            <div key={k} className="space-y-1.5">
              <Label htmlFor={k}>{k === "primaryColor" ? "Primary colour" : "Accent colour"}</Label>
              <div className="flex gap-2">
                <input type="color" aria-label={k} value={b[k]} disabled={!canEdit} onChange={(e) => setB({ ...b, [k]: e.target.value })} className="h-8 w-10 cursor-pointer rounded border bg-transparent" />
                <Input id={k} value={b[k]} disabled={!canEdit} onChange={(e) => setB({ ...b, [k]: e.target.value })} className="font-mono" />
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <span className="grid size-9 place-items-center rounded-lg text-sm font-semibold text-white" style={{ background: b.primaryColor }}>
            N
          </span>
          <span className="rounded-md px-2 py-1 text-sm font-medium text-white" style={{ background: b.primaryColor }}>
            Primary action
          </span>
          <span className="size-2.5 rounded-full" style={{ background: b.accentColor }} />
          <span className="text-sm text-muted-foreground">Accent</span>
        </div>
        {canEdit && (
          <Button onClick={() => save({ branding: b })} disabled={busy}>
            {busy ? <Loader2Icon className="animate-spin" /> : <SaveIcon />} Save branding
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function Compliance({ settings, canEdit }: Props) {
  const [s, setS] = useState(settings);
  const { save, busy } = useSave();
  const num = (v: string) => Math.max(0, Number(v) || 0);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Consent policy</CardTitle>
          <CardDescription className="text-xs">How the eligibility engine treats clients without a consent record.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {(["WHATSAPP", "EMAIL"] as const).map((ch) => (
            <div key={ch} className="grid grid-cols-[110px_1fr] items-center gap-3">
              <Label>{ch === "EMAIL" ? "Email" : "WhatsApp"}</Label>
              <Select disabled={!canEdit} value={s.consentPolicy[ch]} onValueChange={(v) => setS({ ...s, consentPolicy: { ...s.consentPolicy, [ch]: v as "OPT_IN" | "OPT_OUT" } })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="OPT_IN">Opt-in required (explicit consent record)</SelectItem>
                  <SelectItem value="OPT_OUT">Allowed unless opted out / unsubscribed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ))}
          <Notice tone="info">WhatsApp Business policy requires recipient opt-in; keep WhatsApp on “Opt-in required”. Unsubscribes and CRM opt-outs are always honoured.</Notice>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Send safety</CardTitle>
          <CardDescription className="text-xs">Guards against accidental mass sends.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Large campaign threshold</Label>
            <Input type="number" disabled={!canEdit} value={s.safety.largeCampaignThreshold} onChange={(e) => setS({ ...s, safety: { ...s.safety, largeCampaignThreshold: num(e.target.value) || 1 } })} />
          </div>
          <div className="space-y-1.5">
            <Label>Default rate / min</Label>
            <Input type="number" disabled={!canEdit} value={s.safety.defaultRateLimitPerMinute} onChange={(e) => setS({ ...s, safety: { ...s.safety, defaultRateLimitPerMinute: num(e.target.value) || 1 } })} />
          </div>
          <div className="space-y-1.5">
            <Label>Quiet hours start (IST)</Label>
            <Input type="time" disabled={!canEdit} value={s.safety.quietHoursStart} onChange={(e) => setS({ ...s, safety: { ...s.safety, quietHoursStart: e.target.value } })} />
          </div>
          <div className="space-y-1.5">
            <Label>Quiet hours end (IST)</Label>
            <Input type="time" disabled={!canEdit} value={s.safety.quietHoursEnd} onChange={(e) => setS({ ...s, safety: { ...s.safety, quietHoursEnd: e.target.value } })} />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Regulatory disclosures</CardTitle>
          <CardDescription className="text-xs">Appended to every email’s hosted content. Final wording requires legal/compliance review.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>SEBI registration line</Label>
            <Input disabled={!canEdit} value={s.compliance.sebiRegistrationText} onChange={(e) => setS({ ...s, compliance: { ...s.compliance, sebiRegistrationText: e.target.value } })} placeholder="e.g. SEBI Registered Research Analyst — Reg. No. INH000000000" />
          </div>
          <div className="space-y-1.5">
            <Label>Email disclaimer</Label>
            <Textarea rows={4} disabled={!canEdit} value={s.compliance.emailDisclaimer} onChange={(e) => setS({ ...s, compliance: { ...s.compliance, emailDisclaimer: e.target.value } })} placeholder="Investments in securities market are subject to market risks…" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch disabled={!canEdit} checked={s.safety.requireDisclaimerInEmail} onCheckedChange={(v) => setS({ ...s, safety: { ...s.safety, requireDisclaimerInEmail: v } })} />
            Require disclaimer before email campaigns can be approved
          </label>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Retention</CardTitle>
          <CardDescription className="text-xs">SEBI (Research Analysts) Regulations require records be maintained for at least five years.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          {(
            [
              ["campaignRecordsYears", "Campaign records (years)", 5],
              ["auditLogYears", "Audit log (years)", 5],
              ["webhookEventsDays", "Raw webhook payloads (days)", 30],
              ["sessionDays", "Session records (days)", 1],
            ] as const
          ).map(([k, l, min]) => (
            <div key={k} className="space-y-1.5">
              <Label>{l}</Label>
              <Input type="number" min={min} disabled={!canEdit} value={s.retention[k]} onChange={(e) => setS({ ...s, retention: { ...s.retention, [k]: Math.max(min, num(e.target.value)) } })} />
            </div>
          ))}
        </CardContent>
      </Card>
      {canEdit && (
        <div className="lg:col-span-2">
          <Button onClick={() => save({ consentPolicy: s.consentPolicy, safety: s.safety, compliance: s.compliance, retention: s.retention })} disabled={busy}>
            {busy ? <Loader2Icon className="animate-spin" /> : <SaveIcon />} Save compliance settings
          </Button>
        </div>
      )}
    </div>
  );
}

function Users({ users, roles, currentUserId }: Props) {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", role: "VIEWER", password: "" });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const update = async (id: string, body: Record<string, unknown>) => {
    try {
      await api(`/api/v1/users/${id}`, { method: "PATCH", body });
      toast.success("User updated");
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <UserPlusIcon /> Add user
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add user</DialogTitle>
              <DialogDescription>Share the initial password securely; the user should change it after first sign-in.</DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {(["name", "email"] as const).map((k) => (
                <div key={k} className="space-y-1.5">
                  <Label className="capitalize">{k}</Label>
                  <Input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} type={k === "email" ? "email" : "text"} />
                </div>
              ))}
              <div className="space-y-1.5">
                <Label>Role</Label>
                <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r.key} value={r.key}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Initial password</Label>
                <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                <p className="text-xs text-muted-foreground">12+ characters with upper, lower case and a digit.</p>
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api("/api/v1/users", { body: form });
                    toast.success("User created");
                    setOpen(false);
                    setForm({ name: "", email: "", role: "VIEWER", password: "" });
                    router.refresh();
                  } catch (e) {
                    toast.error(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy && <Loader2Icon className="animate-spin" />} Create user
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Last sign-in</TableHead>
              <TableHead>Active</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <p className="font-medium">{u.name}</p>
                  <p className="text-xs text-muted-foreground">{u.email}</p>
                </TableCell>
                <TableCell>
                  <Select value={u.role} onValueChange={(v) => update(u.id, { role: v })} disabled={u.id === currentUserId}>
                    <SelectTrigger size="sm" className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {roles.map((r) => (
                        <SelectItem key={r.key} value={r.key}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{relativeTime(u.lastLoginAt)}</TableCell>
                <TableCell>
                  <Switch checked={u.isActive} disabled={u.id === currentUserId} onCheckedChange={(v) => update(u.id, { isActive: v })} aria-label={`Active: ${u.name}`} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {roles.map((r) => (
          <Card key={r.key} size="sm">
            <CardHeader>
              <CardTitle className="text-sm font-semibold">{r.label}</CardTitle>
              <CardDescription className="text-xs">{r.description}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-1">
              {r.permissions.map((perm) => (
                <span key={perm} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                  {perm}
                </span>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

function TestRecipients({ testRecipients, canEdit }: Props) {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", phone: "" });
  const [busy, setBusy] = useState(false);
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Approved internal test recipients</CardTitle>
        <CardDescription className="text-xs">Test sends from Campaign Studio can only target these people — never clients.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="divide-y rounded-lg border">
          {testRecipients.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span>
                <span className="font-medium">{r.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {[r.email, r.phoneE164].filter(Boolean).join(" · ")}
                </span>
              </span>
              {canEdit && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Remove ${r.name}`}
                  onClick={async () => {
                    try {
                      await api(`/api/v1/test-recipients/${r.id}`, { method: "DELETE" });
                      router.refresh();
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  <Trash2Icon />
                </Button>
              )}
            </li>
          ))}
          {!testRecipients.length && <li className="px-3 py-6 text-center text-sm text-muted-foreground">No test recipients yet.</li>}
        </ul>
        {canEdit && (
          <div className="grid gap-2 md:grid-cols-[1fr_1fr_1fr_auto]">
            <Input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <Input placeholder="Mobile (+91…)" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            <Button
              disabled={busy || form.name.length < 2}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("/api/v1/test-recipients", { body: form });
                  setForm({ name: "", email: "", phone: "" });
                  router.refresh();
                } catch (e) {
                  toast.error(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <PlusIcon /> Add
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Suppression({ suppressions, canSuppress }: Props) {
  const router = useRouter();
  const [form, setForm] = useState({ identifierType: "EMAIL", identifierValue: "", channel: "ALL", reason: "MANUAL" });
  return (
    <div className="space-y-4">
      {canSuppress && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Add identifier</CardTitle>
            <CardDescription className="text-xs">Suppressions apply to every future campaign, regardless of category or consent.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 md:grid-cols-[130px_1fr_150px_170px_auto]">
            <Select value={form.identifierType} onValueChange={(v) => setForm({ ...form, identifierType: v })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="EMAIL">Email</SelectItem>
                <SelectItem value="PHONE">Phone</SelectItem>
              </SelectContent>
            </Select>
            <Input placeholder={form.identifierType === "EMAIL" ? "name@example.com" : "+91 98…"} value={form.identifierValue} onChange={(e) => setForm({ ...form, identifierValue: e.target.value })} />
            <Select value={form.channel} onValueChange={(v) => setForm({ ...form, channel: v })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All channels</SelectItem>
                <SelectItem value="EMAIL">Email</SelectItem>
                <SelectItem value="WHATSAPP">WhatsApp</SelectItem>
              </SelectContent>
            </Select>
            <Select value={form.reason} onValueChange={(v) => setForm({ ...form, reason: v })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["MANUAL", "UNSUBSCRIBED", "HARD_BOUNCE", "COMPLAINT", "DND", "INVALID_CONTACT", "LEGAL_HOLD"].map((r) => (
                  <SelectItem key={r} value={r}>
                    {r.replace("_", " ").toLowerCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              onClick={async () => {
                try {
                  await api("/api/v1/suppressions", { body: { ...form, channel: form.channel === "ALL" ? null : form.channel } });
                  toast.success("Added to suppression list");
                  setForm({ ...form, identifierValue: "" });
                  router.refresh();
                } catch (e) {
                  toast.error(errorMessage(e));
                }
              }}
            >
              <PlusIcon /> Add
            </Button>
          </CardContent>
        </Card>
      )}
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Identifier</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Client</TableHead>
              <TableHead>Added</TableHead>
              {canSuppress && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {suppressions.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-xs">{s.identifierValue}</TableCell>
                <TableCell>{s.channel ? <Pill tone={s.channel === "EMAIL" ? "brand" : "success"}>{s.channel.toLowerCase()}</Pill> : <Pill tone="danger">all channels</Pill>}</TableCell>
                <TableCell className="text-sm">{s.reason.replace("_", " ").toLowerCase()}</TableCell>
                <TableCell>{s.client ? <Link href={`/clients/${s.client.id}`} className="hover:underline">{s.client.fullName}</Link> : <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatIST(s.createdAt)} · {s.source}
                </TableCell>
                {canSuppress && (
                  <TableCell>
                    <ConfirmDialog
                      trigger={
                        <Button size="xs" variant="ghost">
                          Lift
                        </Button>
                      }
                      title="Lift suppression?"
                      description="This identifier becomes eligible again (consent rules still apply). The action is audited."
                      confirmLabel="Lift"
                      onConfirm={async () => {
                        await api(`/api/v1/suppressions/${s.id}/lift`, { method: "POST" });
                        router.refresh();
                      }}
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
            {!suppressions.length && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                  The suppression list is empty.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
