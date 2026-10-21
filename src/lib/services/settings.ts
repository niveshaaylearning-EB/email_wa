import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";

export const AppSettingsSchema = z.object({
  branding: z
    .object({
      productName: z.string().max(60).default("Niveshaay Communication Center"),
      primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#1E3A5F"),
      accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#0F8B6E"),
    })
    .default({ productName: "Niveshaay Communication Center", primaryColor: "#1E3A5F", accentColor: "#0F8B6E" }),
  consentPolicy: z
    .object({
      EMAIL: z.enum(["OPT_IN", "OPT_OUT"]).default("OPT_OUT"),
      WHATSAPP: z.enum(["OPT_IN", "OPT_OUT"]).default("OPT_IN"),
    })
    .default({ EMAIL: "OPT_OUT", WHATSAPP: "OPT_IN" }),
  safety: z
    .object({
      /** Campaigns larger than this require typing the recipient count to confirm. */
      largeCampaignThreshold: z.number().int().min(1).default(500),
      defaultRateLimitPerMinute: z.number().int().min(1).max(6000).default(60),
      /** Quiet hours in IST during which nothing is dispatched (HH:mm). */
      quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/).default("21:00"),
      quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/).default("08:00"),
      requireDisclaimerInEmail: z.boolean().default(true),
    })
    .default({ largeCampaignThreshold: 500, defaultRateLimitPerMinute: 60, quietHoursStart: "21:00", quietHoursEnd: "08:00", requireDisclaimerInEmail: true }),
  retention: z
    .object({
      webhookEventsDays: z.number().int().min(30).default(180),
      sessionDays: z.number().int().min(1).default(30),
      /** SEBI RA regulations require records be maintained for at least 5 years. */
      campaignRecordsYears: z.number().int().min(5).default(5),
      auditLogYears: z.number().int().min(5).default(8),
    })
    .default({ webhookEventsDays: 180, sessionDays: 30, campaignRecordsYears: 5, auditLogYears: 8 }),
  compliance: z
    .object({
      sebiRegistrationText: z.string().max(500).default(""),
      emailDisclaimer: z.string().max(2000).default(""),
    })
    .default({ sebiRegistrationText: "", emailDisclaimer: "" }),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;

const KEY = "app";

export async function getAppSettings(): Promise<AppSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  return AppSettingsSchema.parse(row?.value ?? {});
}

export async function updateAppSettings(patch: Partial<AppSettings>, actor: AuditActor): Promise<AppSettings> {
  const current = await getAppSettings();
  const next = AppSettingsSchema.parse({
    ...current,
    ...Object.fromEntries(
      Object.entries(patch).map(([k, v]) => [k, typeof v === "object" && v ? { ...(current as Record<string, object>)[k], ...v } : v]),
    ),
  });
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: next as Prisma.InputJsonValue, updatedById: actor.id },
    update: { value: next as Prisma.InputJsonValue, updatedById: actor.id },
  });
  await audit({ actor, action: "settings.updated", entityType: "settings", entityId: KEY, metadata: { sections: Object.keys(patch) } });
  return next;
}

/** True if `now` falls inside IST quiet hours. */
export function inQuietHours(settings: AppSettings, now = new Date()): boolean {
  const ist = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  const { quietHoursStart: s, quietHoursEnd: e } = settings.safety;
  return s <= e ? ist >= s && ist < e : ist >= s || ist < e;
}
