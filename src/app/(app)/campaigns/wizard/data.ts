import "server-only";
import { listCategories } from "@/lib/services/categories";
import { prisma } from "@/lib/db";
import { getAppSettings } from "@/lib/services/settings";
import { listIntegrationsForUi } from "@/lib/services/integrations";
import { toRenderable } from "@/lib/services/templates";
import type { RenderableTemplate } from "@/lib/domain/template-render";

export interface WizardCategory {
  id: string;
  name: string;
  color: string;
  priority: number;
  memberCount: number;
  templates: { id: string; channel: "EMAIL" | "WHATSAPP"; name: string; approvalStatus: string; isDefault: boolean }[];
}

export async function loadWizardData() {
  const [cats, templates, settings, integrations, testRecipients] = await Promise.all([
    listCategories(),
    prisma.template.findMany({ where: { archivedAt: null } }),
    getAppSettings(),
    listIntegrationsForUi(),
    prisma.internalTestRecipient.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
  ]);
  return {
    categories: cats.map<WizardCategory>((c) => ({
      id: c.id,
      name: c.name,
      color: c.color,
      priority: c.priority,
      memberCount: c.memberCount,
      templates: c.templates.map((t) => ({ id: t.id, channel: t.channel, name: t.name, approvalStatus: t.approvalStatus, isDefault: t.isDefault })),
    })),
    templates: Object.fromEntries(templates.map((t) => [t.id, toRenderable(t)])) as Record<string, RenderableTemplate>,
    defaults: { rateLimitPerMinute: settings.safety.defaultRateLimitPerMinute, largeCampaignThreshold: settings.safety.largeCampaignThreshold, quietHours: `${settings.safety.quietHoursStart}–${settings.safety.quietHoursEnd}` },
    modes: Object.fromEntries(integrations.map((i) => [i.provider, i.mode])) as Record<string, "MOCK" | "DRY_RUN" | "LIVE">,
    testRecipients: testRecipients.map((r) => ({ id: r.id, name: r.name, email: r.email, phoneE164: r.phoneE164 })),
  };
}
