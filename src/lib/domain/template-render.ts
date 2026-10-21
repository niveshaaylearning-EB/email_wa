/**
 * Template variable validation & rendering.
 *
 * Tokens use {{variable_key}}. Each template declares its variables with a data source.
 * Email templates may only use campaign/static variables: Zoho Marketing Automation list
 * APIs accept email addresses only (no per-lead fields via bulk add), so per-recipient
 * personalization must use Zoho merge tags authored in Zoho itself, which we pass through
 * untouched. WhatsApp templates map variables onto DoubleTick V2 placeholders.
 */
import { z } from "zod";

export const VARIABLE_SOURCES = [
  "client.firstName",
  "client.lastName",
  "client.fullName",
  "client.city",
  "client.email",
  "campaign.name",
  "static",
] as const;
export type VariableSource = (typeof VARIABLE_SOURCES)[number];

export const TemplateVariableSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, "lowercase letters, digits and underscores; must start with a letter"),
  label: z.string().min(1).max(80),
  source: z.enum(VARIABLE_SOURCES),
  required: z.boolean().default(true),
  fallback: z.string().max(200).optional(),
  staticValue: z.string().max(500).optional(),
  sample: z.string().max(200).optional(),
  /** WhatsApp only: where the value goes and the V2 placeholder key name. */
  waPlacement: z.enum(["body", "button_url"]).optional(),
  waParamName: z.string().max(60).optional(),
});
export type TemplateVariable = z.infer<typeof TemplateVariableSchema>;

export const WhatsAppHeaderSchema = z.object({
  type: z.enum(["TEXT", "IMAGE", "DOCUMENT", "VIDEO"]),
  mediaUrl: z.url().optional(),
  text: z.string().max(60).optional(),
});
export type WhatsAppHeader = z.infer<typeof WhatsAppHeaderSchema>;

export interface RenderableTemplate {
  id: string;
  channel: "EMAIL" | "WHATSAPP";
  name: string;
  providerTemplateId: string | null;
  language: string | null;
  subject: string | null;
  body: string;
  header: WhatsAppHeader | null;
  variables: TemplateVariable[];
}

export interface RenderContext {
  client?: {
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
    city?: string | null;
    email?: string | null;
  };
  campaign?: { name?: string | null };
}

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export function extractTokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...new Set([...text.matchAll(TOKEN_RE)].map((m) => m[1]))];
}

export interface TemplateIssue {
  level: "error" | "warning";
  message: string;
}

export function validateTemplateDefinition(t: RenderableTemplate): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  const declared = new Map(t.variables.map((v) => [v.key, v]));
  const used = new Set([...extractTokens(t.body), ...extractTokens(t.subject)]);

  if (t.variables.length !== declared.size) issues.push({ level: "error", message: "Duplicate variable keys." });
  for (const token of used) {
    if (!declared.has(token)) issues.push({ level: "error", message: `Placeholder {{${token}}} is not declared as a variable.` });
  }
  for (const v of t.variables) {
    if (!used.has(v.key) && !(t.channel === "WHATSAPP" && v.waPlacement === "button_url")) {
      issues.push({ level: "warning", message: `Variable "${v.key}" is declared but not used in the content.` });
    }
    if (v.source === "static" && !v.staticValue) {
      issues.push({ level: "error", message: `Static variable "${v.key}" has no value.` });
    }
    if (t.channel === "EMAIL" && v.source.startsWith("client.")) {
      issues.push({
        level: "error",
        message: `Email variable "${v.key}" uses per-recipient data (${v.source}). Zoho Marketing Automation bulk lists carry email addresses only — use a Zoho merge tag inside the Zoho-hosted content instead, or a campaign/static value.`,
      });
    }
    if (t.channel === "WHATSAPP" && !v.waPlacement) {
      issues.push({ level: "error", message: `WhatsApp variable "${v.key}" needs a placement (body or button URL).` });
    }
  }
  if (t.channel === "WHATSAPP") {
    if (!t.providerTemplateId) issues.push({ level: "error", message: "DoubleTick approved template name is required." });
    if (!t.language) issues.push({ level: "error", message: "Template language is required." });
    if (t.header && t.header.type !== "TEXT" && !t.header.mediaUrl) {
      issues.push({ level: "error", message: `${t.header.type} header requires a media URL.` });
    }
  }
  if (t.channel === "EMAIL" && !t.subject) issues.push({ level: "error", message: "Email subject is required." });
  return issues;
}

function resolveVariable(v: TemplateVariable, ctx: RenderContext): string | null {
  let value: string | null | undefined;
  switch (v.source) {
    case "client.firstName":
      value = ctx.client?.firstName;
      break;
    case "client.lastName":
      value = ctx.client?.lastName;
      break;
    case "client.fullName":
      value = ctx.client?.fullName;
      break;
    case "client.city":
      value = ctx.client?.city;
      break;
    case "client.email":
      value = ctx.client?.email;
      break;
    case "campaign.name":
      value = ctx.campaign?.name;
      break;
    case "static":
      value = v.staticValue;
      break;
  }
  const trimmed = value?.toString().trim();
  if (trimmed) return trimmed;
  return v.fallback?.trim() || null;
}

export interface RenderResult {
  subject: string | null;
  body: string;
  values: Record<string, string>;
  missing: string[];
  whatsapp?: DoubleTickTemplateContent;
}

/** Matches the DoubleTick V2 `content` object (docs.doubletick.io/reference/outgoing-messages-whatsapp-template-v2). */
export interface DoubleTickTemplateContent {
  templateName: string;
  language: string;
  templateData?: {
    header?: { type: string; mediaUrl?: string };
    body?: { placeholders: Record<string, string>[] };
    buttons?: { type: "URL"; parameter: string }[];
  };
}

export function renderTemplate(t: RenderableTemplate, ctx: RenderContext, opts: { useSamples?: boolean } = {}): RenderResult {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const v of t.variables) {
    const resolved = resolveVariable(v, ctx) ?? (opts.useSamples ? v.sample ?? null : null);
    if (resolved === null) {
      if (v.required) missing.push(v.key);
      values[v.key] = "";
    } else values[v.key] = resolved;
  }
  const sub = (text: string) => text.replace(TOKEN_RE, (_, key: string) => values[key] ?? "");
  const result: RenderResult = {
    subject: t.subject ? sub(t.subject) : null,
    body: sub(t.body),
    values,
    missing,
  };

  if (t.channel === "WHATSAPP" && t.providerTemplateId && t.language) {
    // Body placeholder order follows the order tokens appear in the approved template body.
    const bodyOrder = extractTokens(t.body);
    const byKey = new Map(t.variables.map((v) => [v.key, v]));
    const placeholders = bodyOrder
      .map((k) => byKey.get(k))
      .filter((v): v is TemplateVariable => !!v && v.waPlacement === "body")
      .map((v) => ({ [v.waParamName || v.key]: values[v.key] }));
    const buttons = t.variables
      .filter((v) => v.waPlacement === "button_url")
      .map((v) => ({ type: "URL" as const, parameter: values[v.key] }));
    const templateData: NonNullable<DoubleTickTemplateContent["templateData"]> = {};
    if (t.header && t.header.type !== "TEXT" && t.header.mediaUrl) {
      templateData.header = { type: t.header.type, mediaUrl: t.header.mediaUrl };
    }
    if (placeholders.length) templateData.body = { placeholders };
    if (buttons.length) templateData.buttons = buttons;
    result.whatsapp = {
      templateName: t.providerTemplateId,
      language: t.language,
      ...(Object.keys(templateData).length ? { templateData } : {}),
    };
  }
  return result;
}

/** Required per-recipient variables that would be empty for this client. */
export function missingRecipientData(t: RenderableTemplate, ctx: RenderContext): string[] {
  return renderTemplate(t, ctx).missing;
}
