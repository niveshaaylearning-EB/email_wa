/**
 * Typed API contracts shared by route handlers (server validation) and forms (client validation).
 * Every mutating endpoint parses its body with one of these schemas.
 */
import { z } from "zod";
import { RuleDefinitionSchema } from "@/lib/domain/rules";
import { TemplateVariableSchema, WhatsAppHeaderSchema } from "@/lib/domain/template-render";

const id = z.string().min(1).max(64);
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #1E3A5F");

// ─── Categories ─────────────────────────────────────────────────────────
export const CategoryCreateSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(80),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  color: hex.default("#1E3A5F"),
  priority: z.coerce.number().int().min(1).max(1000).default(100),
});
export type CategoryCreate = z.infer<typeof CategoryCreateSchema>;
export const CategoryUpdateSchema = CategoryCreateSchema.partial();

export const MembershipChangeSchema = z.object({
  clientIds: z.array(id).min(1).max(10_000),
  categoryIds: z.array(id).min(1).max(100),
  note: z.string().max(300).optional(),
});
export type MembershipChange = z.infer<typeof MembershipChangeSchema>;

export const CsvMembershipImportSchema = z.object({
  categoryId: id,
  /** Raw CSV text (max ~5 MB). Columns: zoho_crm_id | email | phone (any one per row). */
  csv: z.string().min(1).max(5_000_000),
  dryRun: z.boolean().default(true),
});

export const RuleCreateSchema = z.object({
  name: z.string().trim().min(2).max(100),
  definition: RuleDefinitionSchema,
  autoRemove: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

// ─── Clients ────────────────────────────────────────────────────────────
export const ClientListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  categoryId: z.string().max(64).optional(),
  uncategorized: z.enum(["1"]).optional(),
  contact: z.enum(["missing_email", "missing_phone", "invalid_phone", "complete"]).optional(),
  consent: z.enum(["email_revoked", "whatsapp_granted", "whatsapp_missing"]).optional(),
  status: z.string().max(60).optional(),
  duplicates: z.enum(["1"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(10).max(200).default(25),
  sort: z.enum(["name", "updated", "email", "categories"]).default("name"),
  dir: z.enum(["asc", "desc"]).default("asc"),
});
export type ClientListQuery = z.infer<typeof ClientListQuerySchema>;

export const ConsentRecordSchema = z.object({
  clientId: id,
  channel: z.enum(["EMAIL", "WHATSAPP"]),
  status: z.enum(["GRANTED", "REVOKED"]),
  source: z.enum(["MANUAL", "CLIENT_REQUEST", "CSV"]).default("MANUAL"),
  evidence: z.string().trim().min(3, "Record how consent was obtained/withdrawn").max(1000),
});

export const SuppressionCreateSchema = z.object({
  channel: z.enum(["EMAIL", "WHATSAPP"]).nullable(),
  identifierType: z.enum(["EMAIL", "PHONE"]),
  identifierValue: z.string().trim().min(3).max(200),
  reason: z.enum(["UNSUBSCRIBED", "HARD_BOUNCE", "COMPLAINT", "MANUAL", "DND", "INVALID_CONTACT", "LEGAL_HOLD"]),
  note: z.string().max(500).optional(),
});

// ─── Templates ──────────────────────────────────────────────────────────
export const TemplateUpsertSchema = z
  .object({
    channel: z.enum(["EMAIL", "WHATSAPP"]),
    name: z.string().trim().min(2).max(100),
    description: z.string().max(500).optional().or(z.literal("")),
    providerTemplateId: z.string().trim().max(200).optional().or(z.literal("")),
    language: z.string().max(10).optional().or(z.literal("")),
    subject: z.string().max(300).optional().or(z.literal("")),
    senderName: z.string().max(100).optional().or(z.literal("")),
    body: z.string().min(1, "Content is required").max(300_000),
    header: WhatsAppHeaderSchema.nullable().optional(),
    variables: z.array(TemplateVariableSchema).max(30).default([]),
    approvalStatus: z.enum(["DRAFT", "PENDING", "APPROVED", "REJECTED", "DISABLED"]).default("DRAFT"),
    changeNote: z.string().max(300).optional(),
  })
  .superRefine((t, ctx) => {
    if (t.channel === "WHATSAPP" && !t.providerTemplateId) {
      ctx.addIssue({ code: "custom", path: ["providerTemplateId"], message: "Enter the approved DoubleTick template name" });
    }
    if (t.channel === "WHATSAPP" && !t.language) ctx.addIssue({ code: "custom", path: ["language"], message: "Language is required" });
    if (t.channel === "EMAIL" && !t.subject) ctx.addIssue({ code: "custom", path: ["subject"], message: "Subject is required" });
  });
export type TemplateUpsert = z.infer<typeof TemplateUpsertSchema>;

export const TemplateMappingSchema = z.object({
  categoryId: id,
  templateId: id,
  isDefault: z.boolean().default(false),
});

export const TemplateRenderTestSchema = z.object({
  clientId: id.optional(),
  sample: z.record(z.string(), z.string()).optional(),
});

// ─── Campaigns ──────────────────────────────────────────────────────────
export const CAMPAIGN_PURPOSES = [
  "RESEARCH_UPDATE",
  "PORTFOLIO_ADVISORY",
  "SERVICE_NOTICE",
  "EVENT_INVITATION",
  "REGULATORY_DISCLOSURE",
  "MARKETING",
  "OTHER",
] as const;

export const CampaignCategoryInputSchema = z.object({
  categoryId: id,
  priority: z.number().int().min(1).max(100),
  emailTemplateId: id.nullable().optional(),
  whatsappTemplateId: id.nullable().optional(),
});

export const CampaignDraftSchema = z.object({
  name: z.string().trim().min(3, "Campaign name must be at least 3 characters").max(120),
  description: z.string().trim().max(1000).optional().or(z.literal("")),
  purpose: z.enum(CAMPAIGN_PURPOSES),
  channelMode: z.enum(["EMAIL", "WHATSAPP", "BOTH"]),
  overlapStrategy: z.enum(["PRIORITY", "PER_CATEGORY", "EXCLUDE_CONFLICTS", "MANUAL_REVIEW"]).default("MANUAL_REVIEW"),
  categories: z
    .array(CampaignCategoryInputSchema)
    .max(50)
    .default([])
    .refine((cs) => new Set(cs.map((c) => c.categoryId)).size === cs.length, "A category can only be selected once")
    .refine((cs) => new Set(cs.map((c) => c.priority)).size === cs.length, "Each category needs a distinct priority"),
  scheduleType: z.enum(["IMMEDIATE", "SCHEDULED"]).default("IMMEDIATE"),
  /** IST wall-clock "yyyy-MM-ddTHH:mm" */
  scheduledAtLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional().or(z.literal("")),
  rateLimitPerMinute: z.coerce.number().int().min(1).max(6000).default(60),
  expectedVersion: z.number().int().optional(),
});
export type CampaignDraft = z.infer<typeof CampaignDraftSchema>;

export const ReviewDecisionSchema = z.object({
  decisions: z
    .array(
      z.object({
        clientId: id,
        channel: z.enum(["EMAIL", "WHATSAPP"]),
        decision: z.union([z.object({ categoryId: id }), z.object({ exclude: z.literal(true) })]),
      }),
    )
    .min(1)
    .max(5000),
});

export const ApprovalSchema = z.object({
  note: z.string().trim().max(1000).optional(),
  /** Approver must type the exact eligible message count shown — protects against stale/mass sends. */
  confirmMessageCount: z.number().int().min(0),
  /** Required (and must be true) to execute against LIVE providers. */
  confirmLive: z.boolean().default(false),
});

export const RejectionSchema = z.object({ reason: z.string().trim().min(5, "Please give the creator a reason").max(1000) });
export const CancelSchema = z.object({ reason: z.string().trim().min(3).max(500) });

export const TestSendSchema = z.object({
  testRecipientIds: z.array(id).min(1).max(10),
  channel: z.enum(["EMAIL", "WHATSAPP"]),
  categoryId: id,
});

// ─── Users & settings ───────────────────────────────────────────────────
export const UserCreateSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().transform((v) => v.toLowerCase()),
  role: z.enum(["ADMIN", "CAMPAIGN_CREATOR", "APPROVER", "VIEWER", "COMPLIANCE_OFFICER"]),
  password: z
    .string()
    .min(12, "At least 12 characters")
    .regex(/[A-Z]/, "Include an uppercase letter")
    .regex(/[a-z]/, "Include a lowercase letter")
    .regex(/\d/, "Include a digit"),
});
export const UserUpdateSchema = z.object({
  role: z.enum(["ADMIN", "CAMPAIGN_CREATOR", "APPROVER", "VIEWER", "COMPLIANCE_OFFICER"]).optional(),
  isActive: z.boolean().optional(),
  name: z.string().trim().min(2).max(100).optional(),
});

export const TestRecipientSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.email().optional().or(z.literal("")),
  phone: z.string().max(30).optional().or(z.literal("")),
});

export const LoginSchema = z.object({
  email: z.email("Enter a valid email"),
  password: z.string().min(1, "Password is required").max(200),
});
