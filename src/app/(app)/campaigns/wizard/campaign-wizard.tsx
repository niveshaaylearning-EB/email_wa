"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangleIcon,
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CheckIcon,
  FlaskConicalIcon,
  InfoIcon,
  Loader2Icon,
  MailIcon,
  MessageCircleIcon,
  SaveIcon,
  SendIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react";
import { api, errorMessage } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Notice } from "@/components/app/empty-state";
import { CategoryChip, ChannelBadge, ModeBadge, Pill } from "@/components/app/status";
import type { AudienceSummary, ExclusionReasonKey } from "@/lib/domain/eligibility";
import { EXCLUSION_LABELS } from "@/lib/domain/labels";
import { renderTemplate, validateTemplateDefinition, type RenderableTemplate } from "@/lib/domain/template-render";
import { CAMPAIGN_PURPOSES } from "@/lib/contracts";
import { cn } from "@/lib/utils";
import type { WizardCategory } from "./data";

type Channel = "EMAIL" | "WHATSAPP";
type Mode = "EMAIL" | "WHATSAPP" | "BOTH";
type Strategy = "PRIORITY" | "PER_CATEGORY" | "EXCLUDE_CONFLICTS" | "MANUAL_REVIEW";

interface DraftCategory {
  categoryId: string;
  priority: number;
  emailTemplateId: string | null;
  whatsappTemplateId: string | null;
}
interface Draft {
  id?: string;
  version?: number;
  status?: string;
  name: string;
  description: string;
  purpose: (typeof CAMPAIGN_PURPOSES)[number];
  channelMode: Mode;
  overlapStrategy: Strategy;
  scheduleType: "IMMEDIATE" | "SCHEDULED";
  scheduledAtLocal: string;
  rateLimitPerMinute: number;
  categories: DraftCategory[];
}
export interface Preview {
  summary: AudienceSummary;
  validation: { errors: string[]; warnings: string[] };
  reviewItems: { clientId: string; clientName: string; channel: Channel; status: string; conflictCategoryIds: string[]; chosenCategoryId: string | null; excluded: boolean }[];
  sample: { clientId: string; fullName: string; email: string | null; phoneE164: string | null; status: string; exclusionReasons: ExclusionReasonKey[]; matchedCategoryIds: string[]; assignments: { channel: Channel; categoryId: string; templateId: string; status: string; reasons: string[] }[] }[];
  totalRecipients: number;
}

const STEPS = ["Details", "Audience", "Channels", "Templates", "Schedule", "Review", "Submit"] as const;
const PURPOSE_LABEL: Record<string, string> = {
  RESEARCH_UPDATE: "Research update",
  PORTFOLIO_ADVISORY: "Portfolio advisory",
  SERVICE_NOTICE: "Service notice",
  EVENT_INVITATION: "Event invitation",
  REGULATORY_DISCLOSURE: "Regulatory disclosure",
  MARKETING: "Marketing / promotional",
  OTHER: "Other",
};
const STRATEGY: Record<Strategy, { title: string; body: string }> = {
  MANUAL_REVIEW: { title: "Manual review (recommended)", body: "Clients in several selected categories with different templates are held until you choose. Nothing is sent to them by default." },
  PRIORITY: { title: "Category priority", body: "Use the template of the highest-priority category the client belongs to (order set above)." },
  PER_CATEGORY: { title: "One message per category", body: "Send each distinct category template. Only use when every message is genuinely relevant." },
  EXCLUDE_CONFLICTS: { title: "Exclude conflicts", body: "Skip clients whose categories map to different templates." },
};
const nf = (n: number) => n.toLocaleString("en-IN");

export function CampaignWizard({
  categories,
  templates,
  defaults,
  modes,
  testRecipients,
  initial,
  initialPreview,
}: {
  categories: WizardCategory[];
  templates: Record<string, RenderableTemplate>;
  defaults: { rateLimitPerMinute: number; largeCampaignThreshold: number; quietHours: string };
  modes: Record<string, "MOCK" | "DRY_RUN" | "LIVE">;
  testRecipients: { id: string; name: string; email: string | null; phoneE164: string | null }[];
  initial?: Draft;
  initialPreview?: Preview | null;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(
    initial ?? {
      name: "",
      description: "",
      purpose: "RESEARCH_UPDATE",
      channelMode: "WHATSAPP",
      overlapStrategy: "MANUAL_REVIEW",
      scheduleType: "IMMEDIATE",
      scheduledAtLocal: "",
      rateLimitPerMinute: defaults.rateLimitPerMinute,
      categories: [],
    },
  );
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(initialPreview ?? null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const catById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const channels: Channel[] = draft.channelMode === "BOTH" ? ["EMAIL", "WHATSAPP"] : [draft.channelMode];
  const patch = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  const save = useCallback(async (): Promise<Draft | null> => {
    setSaving(true);
    try {
      const body = { ...draft, expectedVersion: draft.version };
      const res = draft.id
        ? await api<{ id: string; version: number; status: string }>(`/api/v1/campaigns/${draft.id}`, { method: "PUT", body })
        : await api<{ id: string; version: number; status: string }>("/api/v1/campaigns", { body });
      const next = { ...draft, id: res.id, version: res.version, status: res.status };
      setDraft(next);
      if (!draft.id) window.history.replaceState(null, "", `/campaigns/${res.id}/edit`);
      return next;
    } catch (e) {
      toast.error(errorMessage(e));
      return null;
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const loadPreview = useCallback(async (id: string) => {
    setLoadingPreview(true);
    try {
      setPreview(await api<Preview>(`/api/v1/campaigns/${id}/preview`));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoadingPreview(false);
    }
  }, []);

  const stepError = (s: number): string | null => {
    if (s === 0 && draft.name.trim().length < 3) return "Give the campaign a name (at least 3 characters).";
    if (s === 1 && draft.categories.length === 0) return "Select at least one category.";
    if (s === 3) {
      for (const c of draft.categories) {
        for (const ch of channels) {
          if (!(ch === "EMAIL" ? c.emailTemplateId : c.whatsappTemplateId)) return `Choose a ${ch === "EMAIL" ? "email" : "WhatsApp"} template for “${catById.get(c.categoryId)?.name}”.`;
        }
      }
    }
    if (s === 4 && draft.scheduleType === "SCHEDULED" && !draft.scheduledAtLocal) return "Pick a date and time, or send immediately after approval.";
    return null;
  };

  const go = async (to: number) => {
    if (to > step) {
      for (let s = step; s < to; s++) {
        const err = stepError(s);
        if (err) {
          toast.error(err);
          return;
        }
      }
    }
    const saved = await save();
    if (!saved) return;
    setStep(to);
    if (saved.id && to >= 1) loadPreview(saved.id);
  };

  // ── category selection helpers ──
  const defaultTemplate = (catId: string, ch: Channel) => {
    const ts = catById.get(catId)?.templates.filter((t) => t.channel === ch) ?? [];
    return (ts.find((t) => t.isDefault && t.approvalStatus === "APPROVED") ?? ts.find((t) => t.approvalStatus === "APPROVED"))?.id ?? null;
  };
  const toggleCategory = (id: string, on: boolean) => {
    setDraft((d) => {
      if (!on) {
        const rest = d.categories.filter((c) => c.categoryId !== id).sort((a, b) => a.priority - b.priority);
        return { ...d, categories: rest.map((c, i) => ({ ...c, priority: i + 1 })) };
      }
      return { ...d, categories: [...d.categories, { categoryId: id, priority: d.categories.length + 1, emailTemplateId: defaultTemplate(id, "EMAIL"), whatsappTemplateId: defaultTemplate(id, "WHATSAPP") }] };
    });
  };
  const move = (id: string, dir: -1 | 1) => {
    setDraft((d) => {
      const sorted = [...d.categories].sort((a, b) => a.priority - b.priority);
      const i = sorted.findIndex((c) => c.categoryId === id);
      const j = i + dir;
      if (j < 0 || j >= sorted.length) return d;
      [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
      return { ...d, categories: sorted.map((c, k) => ({ ...c, priority: k + 1 })) };
    });
  };
  const setTemplate = (catId: string, ch: Channel, tid: string) =>
    setDraft((d) => ({ ...d, categories: d.categories.map((c) => (c.categoryId === catId ? { ...c, [ch === "EMAIL" ? "emailTemplateId" : "whatsappTemplateId"]: tid } : c)) }));

  const selected = [...draft.categories].sort((a, b) => a.priority - b.priority);
  const s = preview?.summary;

  return (
    <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
      <nav aria-label="Campaign steps" className="lg:sticky lg:top-20 lg:self-start">
        <ol className="flex gap-1 overflow-x-auto lg:flex-col">
          {STEPS.map((label, i) => (
            <li key={label}>
              <button
                onClick={() => (i < step ? go(i) : i === step + 1 ? go(i) : undefined)}
                disabled={i > step + 1 || saving}
                className={cn(
                  "flex w-full items-center gap-3 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition-colors",
                  i === step ? "bg-primary/10 font-medium text-primary" : i < step ? "text-foreground hover:bg-muted" : "text-muted-foreground",
                )}
              >
                <span className={cn("grid size-6 shrink-0 place-items-center rounded-full border text-xs", i < step && "border-primary bg-primary text-primary-foreground", i === step && "border-primary text-primary")}>
                  {i < step ? <CheckIcon className="size-3.5" /> : i + 1}
                </span>
                {label}
              </button>
            </li>
          ))}
        </ol>
        {draft.id && <p className="mt-3 hidden px-3 text-xs text-muted-foreground lg:block">{saving ? "Saving…" : `Draft saved · v${draft.version}`}</p>}
      </nav>

      <div className="min-w-0 space-y-5">
        {step === 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Campaign details</CardTitle>
              <CardDescription>Describe the communication. Purpose is recorded for compliance review.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="c-name">Campaign name</Label>
                <Input id="c-name" value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder="e.g. Q3 results — Premium research note" autoFocus />
              </div>
              <div className="space-y-1.5">
                <Label>Communication purpose</Label>
                <Select value={draft.purpose} onValueChange={(v) => patch({ purpose: v as Draft["purpose"] })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CAMPAIGN_PURPOSES.map((p) => (
                      <SelectItem key={p} value={p}>
                        {PURPOSE_LABEL[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="c-desc">Description</Label>
                <Textarea id="c-desc" rows={3} value={draft.description} onChange={(e) => patch({ description: e.target.value })} placeholder="What is being communicated and why — visible to the approver." />
              </div>
              {draft.purpose === "MARKETING" && (
                <Notice tone="warning" icon={AlertTriangleIcon} className="md:col-span-2" title="Promotional communication">
                  Promotional content from a SEBI-registered entity needs compliance sign-off and the required disclosures. Ensure the template includes them.
                </Notice>
              )}
            </CardContent>
          </Card>
        )}

        {step === 1 && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Audience</CardTitle>
                <CardDescription>Only members of the selected categories can receive this campaign. Order sets precedence for overlapping clients.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-5 lg:grid-cols-2">
                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Available categories</p>
                  <ul className="max-h-[420px] space-y-1 overflow-y-auto pr-1">
                    {categories.map((c) => {
                      const on = draft.categories.some((x) => x.categoryId === c.id);
                      return (
                        <li key={c.id}>
                          <label className={cn("flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors", on ? "border-primary/40 bg-primary/5" : "hover:bg-muted/50")}>
                            <Checkbox checked={on} onCheckedChange={(v) => toggleCategory(c.id, !!v)} />
                            <span className="size-2.5 rounded-full" style={{ background: c.color }} />
                            <span className="flex-1 truncate font-medium">{c.name}</span>
                            <span className="tabular text-xs text-muted-foreground">{nf(c.memberCount)}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <div>
                  <p className="mb-2 text-xs font-medium text-muted-foreground">Selected · precedence order</p>
                  {selected.length ? (
                    <ol className="space-y-1.5">
                      {selected.map((c, i) => {
                        const cat = catById.get(c.categoryId);
                        return (
                          <li key={c.categoryId} className="flex items-center gap-2 rounded-lg border bg-surface px-3 py-2 text-sm">
                            <span className="tabular grid size-5 place-items-center rounded bg-muted text-[11px] font-medium">{i + 1}</span>
                            <span className="size-2.5 rounded-full" style={{ background: cat?.color }} />
                            <span className="flex-1 truncate">{cat?.name}</span>
                            <Button variant="ghost" size="icon-xs" aria-label="Move up" disabled={i === 0} onClick={() => move(c.categoryId, -1)}>
                              <ArrowUpIcon />
                            </Button>
                            <Button variant="ghost" size="icon-xs" aria-label="Move down" disabled={i === selected.length - 1} onClick={() => move(c.categoryId, 1)}>
                              <ArrowDownIcon />
                            </Button>
                          </li>
                        );
                      })}
                    </ol>
                  ) : (
                    <p className="rounded-lg border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">Select one or more categories</p>
                  )}
                  {selected.length > 1 && (
                    <div className="mt-4 space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">When a client is in several selected categories with different templates</p>
                      <RadioGroup value={draft.overlapStrategy} onValueChange={(v) => patch({ overlapStrategy: v as Strategy })} className="gap-1.5">
                        {(Object.keys(STRATEGY) as Strategy[]).map((k) => (
                          <label key={k} className={cn("flex cursor-pointer gap-3 rounded-lg border px-3 py-2", draft.overlapStrategy === k && "border-primary/40 bg-primary/5")}>
                            <RadioGroupItem value={k} className="mt-0.5" />
                            <span>
                              <span className="block text-sm font-medium">{STRATEGY[k].title}</span>
                              <span className="block text-xs text-muted-foreground">{STRATEGY[k].body}</span>
                            </span>
                          </label>
                        ))}
                      </RadioGroup>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
            <Button variant="outline" size="sm" onClick={() => go(1)} disabled={saving || !draft.categories.length}>
              {saving || loadingPreview ? <Loader2Icon className="animate-spin" /> : <UsersIcon />} Recalculate audience
            </Button>
            <AudienceStats summary={s} loading={loadingPreview} channels={channels} />
          </>
        )}

        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle>Channels</CardTitle>
              <CardDescription>Each channel is checked independently for contact details, consent and suppression.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              {(
                [
                  ["EMAIL", "Email only", MailIcon, "Zoho Marketing Automation"],
                  ["WHATSAPP", "WhatsApp only", MessageCircleIcon, "DoubleTick (approved templates)"],
                  ["BOTH", "Email + WhatsApp", SendIcon, "One message per channel"],
                ] as const
              ).map(([k, label, Icon, sub]) => (
                <button
                  key={k}
                  onClick={() => patch({ channelMode: k })}
                  className={cn("flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors", draft.channelMode === k ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "hover:bg-muted/50")}
                >
                  <Icon className="size-5 text-primary" />
                  <span className="font-medium">{label}</span>
                  <span className="text-xs text-muted-foreground">{sub}</span>
                  {s && (
                    <span className="text-xs text-muted-foreground">
                      {k === "BOTH" ? `${nf(s.contactableByChannel.EMAIL)} email · ${nf(s.contactableByChannel.WHATSAPP)} WhatsApp reachable` : `${nf(s.contactableByChannel[k])} reachable`}
                    </span>
                  )}
                  <span className="mt-auto">{k !== "BOTH" && <ModeBadge mode={modes[k === "EMAIL" ? "ZOHO_MA" : "DOUBLETICK"]} />}</span>
                </button>
              ))}
            </CardContent>
          </Card>
        )}

        {step === 3 && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Templates</CardTitle>
                <CardDescription>Only templates authorised for each category are offered. Previews use sample data.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {selected.map((c) => {
                  const cat = catById.get(c.categoryId)!;
                  return (
                    <div key={c.categoryId} className="rounded-xl border p-4">
                      <div className="mb-3 flex items-center gap-2">
                        <CategoryChip name={cat.name} color={cat.color} />
                        <span className="text-xs text-muted-foreground">priority {c.priority}</span>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        {channels.map((ch) => {
                          const options = cat.templates.filter((t) => t.channel === ch);
                          const tid = ch === "EMAIL" ? c.emailTemplateId : c.whatsappTemplateId;
                          const t = tid ? templates[tid] : undefined;
                          const r = t ? renderTemplate(t, { client: { firstName: "Asha", lastName: "Patel", fullName: "Asha Patel", city: "Ahmedabad" }, campaign: { name: draft.name } }, { useSamples: true }) : null;
                          const issues = t ? validateTemplateDefinition(t).filter((i) => i.level === "error") : [];
                          const approved = options.find((o) => o.id === tid)?.approvalStatus === "APPROVED";
                          return (
                            <div key={ch} className="space-y-2">
                              <div className="flex items-center justify-between">
                                <ChannelBadge channel={ch} />
                                {tid && !approved && <Pill tone="warning">Not approved</Pill>}
                              </div>
                              {options.length ? (
                                <Select value={tid ?? ""} onValueChange={(v) => setTemplate(c.categoryId, ch, v)}>
                                  <SelectTrigger className="w-full">
                                    <SelectValue placeholder="Choose template" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {options.map((o) => (
                                      <SelectItem key={o.id} value={o.id}>
                                        {o.name}
                                        {o.isDefault ? " · default" : ""}
                                        {o.approvalStatus !== "APPROVED" ? ` (${o.approvalStatus.toLowerCase()})` : ""}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              ) : (
                                <Notice tone="danger" icon={AlertTriangleIcon}>
                                  No {ch === "EMAIL" ? "email" : "WhatsApp"} template is authorised for this category. Map one from the category’s Templates tab.
                                </Notice>
                              )}
                              {r && (
                                <div className="rounded-lg bg-muted/60 p-3 text-xs">
                                  {r.subject && <p className="mb-1 font-medium">Subject: {r.subject}</p>}
                                  <p className="line-clamp-4 whitespace-pre-wrap text-muted-foreground">{ch === "EMAIL" ? r.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : r.body}</p>
                                </div>
                              )}
                              {issues.map((i, k) => (
                                <p key={k} className="text-xs text-destructive">
                                  {i.message}
                                </p>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
            {draft.id && preview && <ConflictReview campaignId={draft.id} preview={preview} categories={catById} onChanged={() => loadPreview(draft.id!)} strategy={draft.overlapStrategy} />}
            {draft.id && <TestSend campaignId={draft.id} recipients={testRecipients} categories={selected.map((c) => catById.get(c.categoryId)!)} channels={channels} onBeforeSend={save} />}
          </>
        )}

        {step === 4 && (
          <Card>
            <CardHeader>
              <CardTitle>Scheduling</CardTitle>
              <CardDescription>All times are India Standard Time (Asia/Kolkata). Sending starts only after approval.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <RadioGroup value={draft.scheduleType} onValueChange={(v) => patch({ scheduleType: v as Draft["scheduleType"] })} className="grid gap-2 md:grid-cols-2">
                <label className={cn("flex cursor-pointer gap-3 rounded-lg border p-3", draft.scheduleType === "IMMEDIATE" && "border-primary/40 bg-primary/5")}>
                  <RadioGroupItem value="IMMEDIATE" className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium">Send after approval</span>
                    <span className="text-xs text-muted-foreground">Queued as soon as an approver signs off.</span>
                  </span>
                </label>
                <label className={cn("flex cursor-pointer gap-3 rounded-lg border p-3", draft.scheduleType === "SCHEDULED" && "border-primary/40 bg-primary/5")}>
                  <RadioGroupItem value="SCHEDULED" className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium">Schedule</span>
                    <span className="text-xs text-muted-foreground">Choose a date and time (IST).</span>
                  </span>
                </label>
              </RadioGroup>
              {draft.scheduleType === "SCHEDULED" && (
                <div className="max-w-xs space-y-1.5">
                  <Label htmlFor="c-when">Send at (IST)</Label>
                  <Input id="c-when" type="datetime-local" value={draft.scheduledAtLocal} onChange={(e) => patch({ scheduledAtLocal: e.target.value })} />
                </div>
              )}
              <div className="max-w-xs space-y-1.5">
                <Label htmlFor="c-rate">Sending rate (messages per minute)</Label>
                <Input id="c-rate" type="number" min={1} max={6000} value={draft.rateLimitPerMinute} onChange={(e) => patch({ rateLimitPerMinute: Number(e.target.value) || 1 })} />
                <p className="text-xs text-muted-foreground">Applies to WhatsApp. Also capped by the DoubleTick throttle in Integrations. Email is sent by Zoho as one provider campaign per category.</p>
              </div>
              <Notice tone="info" icon={InfoIcon}>
                Live campaigns are deferred automatically during quiet hours ({defaults.quietHours} IST).
              </Notice>
            </CardContent>
          </Card>
        )}

        {step === 5 && <ReviewStep draft={draft} preview={preview} loading={loadingPreview} catById={catById} templates={templates} channels={channels} modes={modes} threshold={defaults.largeCampaignThreshold} />}

        {step === 6 && (
          <Card>
            <CardHeader>
              <CardTitle>Request approval</CardTitle>
              <CardDescription>A different user with the Approver role must approve. The audience is re-calculated and frozen at the moment of approval.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {preview?.validation.errors.length ? (
                <Notice tone="danger" icon={AlertTriangleIcon} title="Fix these before submitting">
                  <ul className="list-disc pl-4">
                    {preview.validation.errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </Notice>
              ) : (
                <Notice tone="success" icon={ShieldCheckIcon} title="Ready for approval">
                  {preview && `${nf(preview.summary.messageVolume)} messages to ${nf(preview.summary.eligibleRecipients)} eligible clients.`} Nothing is sent until the campaign is approved{draft.scheduleType === "SCHEDULED" ? " and the scheduled time arrives" : ""}.
                </Notice>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={saving || !preview || preview.validation.errors.length > 0}
                  onClick={async () => {
                    const saved = await save();
                    if (!saved?.id) return;
                    try {
                      await api(`/api/v1/campaigns/${saved.id}/submit`, { method: "POST" });
                      toast.success("Submitted for approval");
                      router.push(`/campaigns/${saved.id}`);
                      router.refresh();
                    } catch (e) {
                      toast.error(errorMessage(e));
                      loadPreview(saved.id);
                    }
                  }}
                >
                  <SendIcon /> Request approval
                </Button>
                <Button
                  variant="outline"
                  onClick={async () => {
                    if (await save()) {
                      toast.success("Draft saved");
                      router.push("/campaigns");
                    }
                  }}
                >
                  <SaveIcon /> Save draft & exit
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex items-center justify-between border-t pt-4">
          <Button variant="ghost" onClick={() => go(step - 1)} disabled={step === 0 || saving}>
            <ArrowLeftIcon /> Back
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={async () => (await save()) && toast.success("Draft saved")} disabled={saving}>
              {saving ? <Loader2Icon className="animate-spin" /> : <SaveIcon />} Save draft
            </Button>
            {step < STEPS.length - 1 && (
              <Button onClick={() => go(step + 1)} disabled={saving}>
                Continue <ArrowRightIcon />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: number | string; tone?: "danger" | "warning" | "success"; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5" title={hint}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("tabular mt-0.5 text-lg font-semibold", tone === "danger" && "text-destructive", tone === "warning" && "text-warning", tone === "success" && "text-success")}>{typeof value === "number" ? nf(value) : value}</p>
    </div>
  );
}

function AudienceStats({ summary: s, loading, channels }: { summary?: AudienceSummary; loading: boolean; channels: Channel[] }) {
  if (!s) return loading ? <div className="h-40 animate-pulse rounded-xl bg-muted" /> : null;
  return (
    <Card className={cn(loading && "opacity-60")}>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Audience breakdown</CardTitle>
        <CardDescription className="text-xs">Calculated from current memberships, consent and suppression. Final numbers are re-checked and frozen at approval.</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-5">
        <Stat label="Total memberships" value={s.totalMemberships} />
        <Stat label="Unique clients" value={s.uniqueClients} />
        <Stat label="In 2+ selected categories" value={s.overlappingClients} tone={s.overlappingClients ? "warning" : undefined} />
        <Stat label="Missing / invalid email" value={s.missingEmail} />
        <Stat label="Missing / invalid phone" value={s.missingPhone} />
        <Stat label="Unsubscribed / opted out" value={s.unsubscribed} />
        <Stat label="No WhatsApp consent" value={s.noConsent} />
        <Stat label="Suppressed" value={s.suppressed} />
        <Stat label="Inactive / duplicate" value={s.inactive + s.duplicates} />
        {channels.map((ch) => (
          <Stat key={ch} label={`Reachable by ${ch === "EMAIL" ? "email" : "WhatsApp"}`} value={s.contactableByChannel[ch]} tone="success" />
        ))}
      </CardContent>
    </Card>
  );
}

function ConflictReview({ campaignId, preview, categories, onChanged, strategy }: { campaignId: string; preview: Preview; categories: Map<string, WizardCategory>; onChanged: () => void; strategy: Strategy }) {
  const items = preview.reviewItems;
  const [busy, setBusy] = useState(false);
  if (!items.length) return null;
  const decide = async (decisions: { clientId: string; channel: Channel; decision: { categoryId: string } | { exclude: true } }[]) => {
    setBusy(true);
    try {
      await api(`/api/v1/campaigns/${campaignId}/review`, { body: { decisions } });
      onChanged();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const pending = items.filter((i) => i.status === "NEEDS_REVIEW");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Overlapping recipients ({items.length})</CardTitle>
        <CardDescription className="text-xs">
          {strategy === "MANUAL_REVIEW"
            ? `${pending.length} need a decision. Choose which category’s template each client should receive, or exclude them.`
            : `Resolved automatically by “${STRATEGY[strategy].title}”. Shown for transparency.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {strategy === "MANUAL_REVIEW" && pending.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {[...new Set(pending.flatMap((p) => p.conflictCategoryIds))].map((cid) => (
              <Button key={cid} size="sm" variant="outline" disabled={busy} onClick={() => decide(pending.filter((p) => p.conflictCategoryIds.includes(cid)).map((p) => ({ clientId: p.clientId, channel: p.channel, decision: { categoryId: cid } })))}>
                Use “{categories.get(cid)?.name}” for all where possible
              </Button>
            ))}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide(pending.map((p) => ({ clientId: p.clientId, channel: p.channel, decision: { exclude: true } })))}>
              Exclude all pending
            </Button>
          </div>
        )}
        <div className="max-h-80 overflow-auto rounded-lg border">
          <Table>
            <TableHeader className="sticky top-0 bg-muted">
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Categories</TableHead>
                <TableHead>Template from</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.slice(0, 300).map((i) => (
                <TableRow key={`${i.clientId}:${i.channel}`}>
                  <TableCell className="font-medium">{i.clientName}</TableCell>
                  <TableCell>
                    <ChannelBadge channel={i.channel} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {i.conflictCategoryIds.map((cid) => (
                        <CategoryChip key={cid} name={categories.get(cid)?.name ?? cid} color={categories.get(cid)?.color ?? "#999"} />
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {strategy === "MANUAL_REVIEW" ? (
                      <Select
                        value={i.excluded ? "__exclude" : i.chosenCategoryId ?? ""}
                        onValueChange={(v) => decide([{ clientId: i.clientId, channel: i.channel, decision: v === "__exclude" ? { exclude: true } : { categoryId: v } }])}
                        disabled={busy}
                      >
                        <SelectTrigger size="sm" className={cn("w-48", i.status === "NEEDS_REVIEW" && "border-warning")}>
                          <SelectValue placeholder="Decide…" />
                        </SelectTrigger>
                        <SelectContent>
                          {i.conflictCategoryIds.map((cid) => (
                            <SelectItem key={cid} value={cid}>
                              {categories.get(cid)?.name}
                            </SelectItem>
                          ))}
                          <SelectItem value="__exclude">Exclude this client</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : i.excluded ? (
                      <Pill tone="muted">Excluded</Pill>
                    ) : (
                      <span className="text-sm">{categories.get(i.chosenCategoryId ?? "")?.name ?? "Per category"}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function TestSend({
  campaignId,
  recipients,
  categories,
  channels,
  onBeforeSend,
}: {
  campaignId: string;
  recipients: { id: string; name: string; email: string | null; phoneE164: string | null }[];
  categories: WizardCategory[];
  channels: Channel[];
  onBeforeSend: () => Promise<unknown>;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [channel, setChannel] = useState<Channel>(channels[0]);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [results, setResults] = useState<{ recipient: string; outcome: string; detail?: unknown }[] | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-semibold">Test send</CardTitle>
        <CardDescription className="text-xs">Only to approved internal test recipients (managed in Settings). In MOCK/DRY-RUN mode the exact payload is shown instead of sending.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {recipients.length ? (
          <>
            <div className="flex flex-wrap gap-2">
              {recipients.map((r) => (
                <label key={r.id} className="flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm">
                  <Checkbox checked={picked.includes(r.id)} onCheckedChange={(v) => setPicked((p) => (v ? [...p, r.id] : p.filter((x) => x !== r.id)))} />
                  {r.name}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Select value={channel} onValueChange={(v) => setChannel(v as Channel)}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c === "EMAIL" ? "Email" : "WhatsApp"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={categoryId} onValueChange={setCategoryId}>
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                disabled={!picked.length || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onBeforeSend();
                    setResults(await api(`/api/v1/campaigns/${campaignId}/test-send`, { body: { testRecipientIds: picked, channel, categoryId } }));
                  } catch (e) {
                    toast.error(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? <Loader2Icon className="animate-spin" /> : <FlaskConicalIcon />} Run test
              </Button>
            </div>
            {results && (
              <ul className="space-y-2">
                {results.map((r, i) => (
                  <li key={i} className="rounded-lg border p-2.5 text-xs">
                    <p className="mb-1 flex items-center gap-2 font-medium">
                      {r.recipient}
                      <Pill tone={r.outcome === "accepted_by_provider" ? "success" : r.outcome === "failed" ? "danger" : "info"}>{r.outcome.replace(/_/g, " ")}</Pill>
                    </p>
                    <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-[11px]">{JSON.stringify(r.detail, null, 2)}</pre>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No internal test recipients configured. An administrator can add them in Settings → Test recipients.</p>
        )}
      </CardContent>
    </Card>
  );
}

function ReviewStep({
  draft,
  preview,
  loading,
  catById,
  templates,
  channels,
  modes,
  threshold,
}: {
  draft: Draft;
  preview: Preview | null;
  loading: boolean;
  catById: Map<string, WizardCategory>;
  templates: Record<string, RenderableTemplate>;
  channels: Channel[];
  modes: Record<string, string>;
  threshold: number;
}) {
  if (!preview) return <div className="h-64 animate-pulse rounded-xl bg-muted" />;
  const s = preview.summary;
  const exclusions = Object.entries(s.exclusionCounts).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0));
  return (
    <div className={cn("space-y-4", loading && "opacity-60")}>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Eligible recipients" value={s.eligibleRecipients} tone="success" />
        <Stat label="Excluded recipients" value={s.excludedRecipients} />
        <Stat label="Estimated messages" value={s.messageVolume} hint={s.messageVolume > threshold ? "Large campaign" : undefined} />
        <Stat label="Need review" value={s.needsReview} tone={s.needsReview ? "warning" : undefined} />
      </div>
      {preview.validation.errors.length > 0 && (
        <Notice tone="danger" icon={AlertTriangleIcon} title="Validation errors">
          <ul className="list-disc pl-4">
            {preview.validation.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      )}
      {preview.validation.warnings.length > 0 && (
        <Notice tone="warning" icon={InfoIcon} title="Warnings">
          <ul className="list-disc pl-4">
            {preview.validation.warnings.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Notice>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="text-right font-medium">{draft.name}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Purpose</dt>
                <dd>{PURPOSE_LABEL[draft.purpose]}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Channels</dt>
                <dd className="flex gap-1">
                  {channels.map((c) => (
                    <span key={c} className="flex items-center gap-1">
                      <ChannelBadge channel={c} />
                      <ModeBadge mode={modes[c === "EMAIL" ? "ZOHO_MA" : "DOUBLETICK"]} />
                    </span>
                  ))}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Overlap rule</dt>
                <dd>{STRATEGY[draft.overlapStrategy].title}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Schedule</dt>
                <dd>{draft.scheduleType === "SCHEDULED" ? `${draft.scheduledAtLocal.replace("T", " ")} IST` : "After approval"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Rate</dt>
                <dd>{draft.rateLimitPerMinute}/min</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Exclusions</CardTitle>
          </CardHeader>
          <CardContent>
            {exclusions.length ? (
              <ul className="space-y-1.5 text-sm">
                {exclusions.map(([k, v]) => (
                  <li key={k} className="flex justify-between">
                    <span className="text-muted-foreground">{EXCLUSION_LABELS[k as ExclusionReasonKey]}</span>
                    <span className="tabular font-medium">{nf(v ?? 0)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No exclusions.</p>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Categories & templates</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Members</TableHead>
                <TableHead className="text-right">Planned messages</TableHead>
                {channels.map((c) => (
                  <TableHead key={c}>{c === "EMAIL" ? "Email template" : "WhatsApp template"}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...draft.categories]
                .sort((a, b) => a.priority - b.priority)
                .map((c) => {
                  const cat = catById.get(c.categoryId)!;
                  return (
                    <TableRow key={c.categoryId}>
                      <TableCell className="tabular">{c.priority}</TableCell>
                      <TableCell>
                        <CategoryChip name={cat.name} color={cat.color} />
                      </TableCell>
                      <TableCell className="tabular text-right">{nf(s.perCategory[c.categoryId]?.members ?? 0)}</TableCell>
                      <TableCell className="tabular text-right">{nf(s.perCategory[c.categoryId]?.planned ?? 0)}</TableCell>
                      {channels.map((ch) => {
                        const tid = ch === "EMAIL" ? c.emailTemplateId : c.whatsappTemplateId;
                        return <TableCell key={ch}>{tid ? templates[tid]?.name : <span className="text-destructive">missing</span>}</TableCell>;
                      })}
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Recipient → template mapping (first {preview.sample.length} of {nf(preview.totalRecipients)})</CardTitle>
          <CardDescription className="text-xs">Full mapping is frozen and visible on the campaign after approval.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="max-h-96 overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 bg-muted">
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Messages</TableHead>
                  <TableHead>Exclusion reasons</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {preview.sample.map((r) => (
                  <TableRow key={r.clientId}>
                    <TableCell className="font-medium">{r.fullName}</TableCell>
                    <TableCell>
                      <Pill tone={r.status === "ELIGIBLE" ? "success" : r.status === "NEEDS_REVIEW" ? "warning" : "muted"}>{r.status.replace("_", " ").toLowerCase()}</Pill>
                    </TableCell>
                    <TableCell className="text-xs">
                      {r.assignments
                        .filter((a) => a.status === "PLANNED")
                        .map((a) => `${a.channel === "EMAIL" ? "Email" : "WA"}: ${templates[a.templateId]?.name ?? "?"} (${catById.get(a.categoryId)?.name})`)
                        .join(" · ") || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{r.exclusionReasons.map((x) => EXCLUSION_LABELS[x]).join(", ") || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
