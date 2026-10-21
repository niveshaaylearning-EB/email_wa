"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { useFieldArray, useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { AlertTriangleIcon, ArchiveIcon, CheckCircle2Icon, InfoIcon, Loader2Icon, PlusIcon, SaveIcon, XIcon } from "lucide-react";
import type { z } from "zod";
import { TemplateUpsertSchema } from "@/lib/contracts";
import { renderTemplate, validateTemplateDefinition, VARIABLE_SOURCES, type TemplateVariable, type WhatsAppHeader } from "@/lib/domain/template-render";
import { api, errorMessage } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { Notice } from "@/components/app/empty-state";

type Values = z.input<typeof TemplateUpsertSchema>;

const SOURCE_LABELS: Record<(typeof VARIABLE_SOURCES)[number], string> = {
  "client.firstName": "Client first name",
  "client.lastName": "Client last name",
  "client.fullName": "Client full name",
  "client.city": "Client city",
  "client.email": "Client email",
  "campaign.name": "Campaign name",
  static: "Fixed value",
};

export function TemplateEditor({
  template,
  initialChannel = "WHATSAPP",
  readOnly,
}: {
  template?: {
    id: string;
    channel: "EMAIL" | "WHATSAPP";
    name: string;
    description: string;
    providerTemplateId: string;
    language: string;
    subject: string;
    senderName: string;
    body: string;
    header: WhatsAppHeader | null;
    variables: TemplateVariable[];
    approvalStatus: Values["approvalStatus"];
  };
  initialChannel?: "EMAIL" | "WHATSAPP";
  readOnly?: boolean;
}) {
  const router = useRouter();
  const form = useForm<Values>({
    resolver: zodResolver(TemplateUpsertSchema),
    defaultValues: template
      ? { ...template, changeNote: "" }
      : {
          channel: initialChannel,
          name: "",
          description: "",
          providerTemplateId: "",
          language: "en",
          subject: "",
          senderName: "",
          body: "",
          header: null,
          variables: [],
          approvalStatus: "DRAFT",
          changeNote: "",
        },
  });
  const vars = useFieldArray({ control: form.control, name: "variables" });
  const values = form.watch();
  const channel = values.channel;

  const preview = useMemo(() => {
    const t = {
      id: template?.id ?? "new",
      channel,
      name: values.name,
      providerTemplateId: values.providerTemplateId || null,
      language: values.language || null,
      subject: values.subject || null,
      body: values.body ?? "",
      header: (values.header as WhatsAppHeader | null) ?? null,
      variables: (values.variables ?? []).map((v) => ({ required: true, ...v })) as TemplateVariable[],
    };
    return {
      issues: validateTemplateDefinition(t),
      rendered: renderTemplate(t, { client: { firstName: "Asha", lastName: "Patel", fullName: "Asha Patel", city: "Ahmedabad", email: "asha@example.com" }, campaign: { name: "Sample campaign" } }, { useSamples: true }),
    };
  }, [values, channel, template?.id]);

  const submit = form.handleSubmit(async (v) => {
    try {
      if (template) {
        await api(`/api/v1/templates/${template.id}`, { method: "PUT", body: v });
        toast.success("Template saved");
        router.refresh();
      } else {
        const t = await api<{ id: string }>("/api/v1/templates", { body: v });
        toast.success("Template created");
        router.push(`/templates/${t.id}`);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });

  const insertToken = (key: string) => {
    const el = document.getElementById("tpl-body") as HTMLTextAreaElement | null;
    const token = `{{${key}}}`;
    const body = form.getValues("body") ?? "";
    if (el) {
      const s = el.selectionStart ?? body.length;
      form.setValue("body", body.slice(0, s) + token + body.slice(el.selectionEnd ?? s), { shouldDirty: true });
    } else form.setValue("body", body + token, { shouldDirty: true });
  };

  const errors = preview.issues.filter((i) => i.level === "error");
  const warnings = preview.issues.filter((i) => i.level === "warning");
  const fe = form.formState.errors;

  return (
    <form onSubmit={submit} className="grid gap-5 xl:grid-cols-[1.25fr_1fr]">
      <fieldset disabled={readOnly} className="space-y-5">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!template && (
              <Controller
                control={form.control}
                name="channel"
                render={({ field }) => (
                  <ToggleGroup type="single" variant="outline" value={field.value} onValueChange={(v) => v && field.onChange(v)}>
                    <ToggleGroupItem value="WHATSAPP" className="px-4">
                      WhatsApp (DoubleTick)
                    </ToggleGroupItem>
                    <ToggleGroupItem value="EMAIL" className="px-4">
                      Email (Zoho MA)
                    </ToggleGroupItem>
                  </ToggleGroup>
                )}
              />
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <Field data-invalid={!!fe.name}>
                <FieldLabel htmlFor="tpl-name">Name</FieldLabel>
                <Input id="tpl-name" {...form.register("name")} placeholder="Internal name" />
                <FieldError errors={[fe.name]} />
              </Field>
              <Field>
                <FieldLabel>Approval status</FieldLabel>
                <Controller
                  control={form.control}
                  name="approvalStatus"
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["DRAFT", "PENDING", "APPROVED", "REJECTED", "DISABLED"].map((s) => (
                          <SelectItem key={s} value={s}>
                            {s.charAt(0) + s.slice(1).toLowerCase()}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <FieldDescription className="text-xs">{channel === "WHATSAPP" ? "Set to Approved only once Meta has approved it in DoubleTick." : "Internal content approval (compliance review)."}</FieldDescription>
              </Field>
            </div>
            {channel === "WHATSAPP" ? (
              <div className="grid gap-4 md:grid-cols-[1fr_140px]">
                <Field data-invalid={!!fe.providerTemplateId}>
                  <FieldLabel htmlFor="tpl-provider">DoubleTick template name</FieldLabel>
                  <Input id="tpl-provider" className="font-mono" {...form.register("providerTemplateId")} placeholder="e.g. research_update_v2" />
                  <FieldDescription className="text-xs">Must exactly match the approved template name in DoubleTick.</FieldDescription>
                  <FieldError errors={[fe.providerTemplateId]} />
                </Field>
                <Field data-invalid={!!fe.language}>
                  <FieldLabel>Language</FieldLabel>
                  <Controller
                    control={form.control}
                    name="language"
                    render={({ field }) => (
                      <Select value={field.value || "en"} onValueChange={field.onChange}>
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {["en", "en_US", "en_GB", "pt_BR", "es", "id"].map((l) => (
                            <SelectItem key={l} value={l}>
                              {l}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                </Field>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-[1fr_220px]">
                <Field data-invalid={!!fe.subject}>
                  <FieldLabel htmlFor="tpl-subject">Subject</FieldLabel>
                  <Input id="tpl-subject" {...form.register("subject")} placeholder="Email subject" />
                  <FieldError errors={[fe.subject]} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="tpl-sender">Sender name (optional)</FieldLabel>
                  <Input id="tpl-sender" {...form.register("senderName")} placeholder="Niveshaay Research" />
                </Field>
              </div>
            )}
            <Field>
              <FieldLabel htmlFor="tpl-desc">Description</FieldLabel>
              <Input id="tpl-desc" {...form.register("description")} placeholder="When to use this template" />
            </Field>
          </CardContent>
        </Card>

        {channel === "WHATSAPP" && (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-semibold">Header</CardTitle>
              <CardDescription className="text-xs">DoubleTick V2 supports media headers (image, document, video) via URL.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-[180px_1fr]">
              <Select
                value={values.header?.type ?? "NONE"}
                onValueChange={(v) => form.setValue("header", v === "NONE" ? null : { type: v as WhatsAppHeader["type"], mediaUrl: values.header?.mediaUrl }, { shouldDirty: true })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="NONE">No dynamic header</SelectItem>
                  <SelectItem value="IMAGE">Image</SelectItem>
                  <SelectItem value="DOCUMENT">Document</SelectItem>
                  <SelectItem value="VIDEO">Video</SelectItem>
                </SelectContent>
              </Select>
              {values.header && values.header.type !== "TEXT" && <Input placeholder="https://… public media URL" {...form.register("header.mediaUrl")} />}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Content</CardTitle>
            <CardDescription className="text-xs">
              {channel === "WHATSAPP"
                ? "Paste the approved template body. Use {{variable}} where the approved template has placeholders, in the same order."
                : "HTML email body. Zoho merge tags are passed through untouched; {{variables}} are filled by this dashboard (campaign-level values only)."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {(values.variables ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {(values.variables ?? []).map((v) => (
                  <Button key={v.key} type="button" size="xs" variant="outline" className="font-mono" onClick={() => insertToken(v.key)} disabled={!v.key}>
                    + {`{{${v.key}}}`}
                  </Button>
                ))}
              </div>
            )}
            <Textarea id="tpl-body" rows={channel === "EMAIL" ? 12 : 6} className="font-mono text-[13px]" {...form.register("body")} />
            <FieldError errors={[fe.body]} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Variables</CardTitle>
            <CardDescription className="text-xs">Each placeholder maps to a data source. Required variables with no value and no fallback exclude that recipient (never sent blank).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {vars.fields.map((f, i) => {
              const src = values.variables?.[i]?.source;
              return (
                <div key={f.id} className="grid gap-2 rounded-lg border p-3 md:grid-cols-6">
                  <Input className="font-mono md:col-span-1" placeholder="key" {...form.register(`variables.${i}.key`)} />
                  <Input className="md:col-span-2" placeholder="Label" {...form.register(`variables.${i}.label`)} />
                  <Controller
                    control={form.control}
                    name={`variables.${i}.source`}
                    render={({ field }) => (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger className="w-full md:col-span-2">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {VARIABLE_SOURCES.filter((s) => channel === "WHATSAPP" || !s.startsWith("client.")).map((s) => (
                            <SelectItem key={s} value={s}>
                              {SOURCE_LABELS[s]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove variable" onClick={() => vars.remove(i)} className="justify-self-end">
                    <XIcon />
                  </Button>
                  {src === "static" ? (
                    <Input className="md:col-span-3" placeholder="Fixed value" {...form.register(`variables.${i}.staticValue`)} />
                  ) : (
                    <Input className="md:col-span-3" placeholder="Fallback if empty (optional)" {...form.register(`variables.${i}.fallback`)} />
                  )}
                  <Input className="md:col-span-2" placeholder="Preview sample" {...form.register(`variables.${i}.sample`)} />
                  <Controller
                    control={form.control}
                    name={`variables.${i}.required`}
                    render={({ field }) => (
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Switch checked={field.value !== false} onCheckedChange={field.onChange} /> Required
                      </label>
                    )}
                  />
                  {channel === "WHATSAPP" && (
                    <>
                      <Controller
                        control={form.control}
                        name={`variables.${i}.waPlacement`}
                        render={({ field }) => (
                          <Select value={field.value ?? "body"} onValueChange={field.onChange}>
                            <SelectTrigger className="w-full md:col-span-3">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="body">Body placeholder</SelectItem>
                              <SelectItem value="button_url">Dynamic URL button parameter</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      />
                      <Input className="font-mono md:col-span-3" placeholder="DoubleTick placeholder key (defaults to key)" {...form.register(`variables.${i}.waParamName`)} />
                    </>
                  )}
                </div>
              );
            })}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                vars.append({ key: "", label: "", source: channel === "WHATSAPP" ? "client.firstName" : "campaign.name", required: true, ...(channel === "WHATSAPP" ? { waPlacement: "body" as const } : {}) })
              }
            >
              <PlusIcon /> Add variable
            </Button>
          </CardContent>
        </Card>

        {template && (
          <Field>
            <FieldLabel htmlFor="tpl-note">Change note (recorded with the new version)</FieldLabel>
            <Input id="tpl-note" {...form.register("changeNote")} placeholder="What changed and why" />
          </Field>
        )}
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
              {template ? "Save new version" : "Create template"}
            </Button>
            {template && (
              <ConfirmDialog
                trigger={
                  <Button type="button" variant="outline">
                    <ArchiveIcon /> Archive
                  </Button>
                }
                title="Archive template?"
                description="It can no longer be selected. Campaigns that already used it keep their frozen version."
                destructive
                confirmLabel="Archive"
                onConfirm={async () => {
                  try {
                    await api(`/api/v1/templates/${template.id}/archive`, { method: "POST" });
                    toast.success("Template archived");
                    router.push("/templates");
                  } catch (e) {
                    toast.error(errorMessage(e));
                    throw e;
                  }
                }}
              />
            )}
          </div>
        )}
      </fieldset>

      <div className="space-y-4 xl:sticky xl:top-20 xl:self-start">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Preview</CardTitle>
            <CardDescription className="text-xs">Rendered with sample data (Asha Patel). Recipients see their own values.</CardDescription>
          </CardHeader>
          <CardContent>
            {channel === "WHATSAPP" ? (
              <div className="rounded-xl bg-[#e9e3d9] p-4 dark:bg-[#0c1a17]">
                <div className="ml-auto max-w-[85%] rounded-lg rounded-tr-none bg-white px-3 py-2 text-sm shadow-sm dark:bg-[#1f2c33]">
                  {values.header && values.header.type !== "TEXT" && (
                    <div className="mb-2 grid h-24 place-items-center rounded bg-muted text-xs text-muted-foreground">{values.header.type.toLowerCase()} header</div>
                  )}
                  <p className="whitespace-pre-wrap text-[#111b21] dark:text-[#e9edef]">{preview.rendered.body || "Template body…"}</p>
                  <p className="mt-1 text-right text-[10px] text-[#667781]">10:42 AM</p>
                </div>
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border">
                <div className="border-b bg-muted/50 px-3 py-2 text-xs">
                  <span className="text-muted-foreground">Subject: </span>
                  <span className="font-medium">{preview.rendered.subject || "—"}</span>
                </div>
                <iframe title="Email preview" sandbox="" className="h-80 w-full bg-white" srcDoc={preview.rendered.body || "<p style='color:#888;font-family:sans-serif'>Email body…</p>"} />
              </div>
            )}
          </CardContent>
        </Card>
        {channel === "WHATSAPP" && preview.rendered.whatsapp && (
          <Card size="sm">
            <CardHeader>
              <CardTitle className="text-xs font-semibold">DoubleTick V2 payload (content)</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="max-h-56 overflow-auto rounded-md bg-muted p-2 text-[11px] leading-relaxed">{JSON.stringify(preview.rendered.whatsapp, null, 2)}</pre>
            </CardContent>
          </Card>
        )}
        {errors.length === 0 && warnings.length === 0 ? (
          <Notice tone="success" icon={CheckCircle2Icon} title="No issues found" />
        ) : (
          <div className="space-y-2">
            {errors.map((e, i) => (
              <Notice key={`e${i}`} tone="danger" icon={AlertTriangleIcon}>
                {e.message}
              </Notice>
            ))}
            {warnings.map((w, i) => (
              <Notice key={`w${i}`} tone="warning" icon={InfoIcon}>
                {w.message}
              </Notice>
            ))}
          </div>
        )}
      </div>
    </form>
  );
}
