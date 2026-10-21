import "server-only";
import { prisma } from "@/lib/db";
import { renderTemplate, type TemplateVariable, type WhatsAppHeader } from "@/lib/domain/template-render";
import { getAppSettings } from "./settings";

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Resolve frozen email HTML for a Zoho-hosted content URL token. Content comes from the
 * template *version* captured at approval, so later template edits never change what was approved.
 */
export async function emailContentForToken(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM campaigns
    WHERE provider_refs @> ${JSON.stringify({ emailGroups: [{ contentToken: token }] })}::jsonb
      AND status IN ('QUEUED','RUNNING','PAUSED','COMPLETED')
    LIMIT 1`;
  if (!rows.length) return null;
  const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: rows[0].id } });
  const group = ((campaign.providerRefs as { emailGroups?: { contentToken: string; categoryId: string; templateId: string }[] }).emailGroups ?? []).find((g) => g.contentToken === token);
  if (!group) return null;
  const assignment = await prisma.campaignMessageAssignment.findFirst({
    where: { campaignId: campaign.id, categoryId: group.categoryId, templateId: group.templateId, channel: "EMAIL" },
    include: { templateVersion: true },
  });
  const snap = assignment?.templateVersion?.snapshot as { body?: string; subject?: string; variables?: TemplateVariable[]; header?: WhatsAppHeader } | undefined;
  if (!snap?.body) return null;
  const rendered = renderTemplate(
    { id: group.templateId, channel: "EMAIL", name: "", providerTemplateId: null, language: null, subject: snap.subject ?? null, body: snap.body, header: null, variables: snap.variables ?? [] },
    { campaign: { name: campaign.name } },
  );
  const settings = await getAppSettings();
  const disclaimer = [settings.compliance.sebiRegistrationText, settings.compliance.emailDisclaimer].filter(Boolean).map(escapeHtml).join("<br/>");
  const body = /<html[\s>]/i.test(rendered.body) ? rendered.body : `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(rendered.subject ?? "")}</title></head><body>${rendered.body}</body></html>`;
  if (!disclaimer) return body;
  const footer = `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:11px;color:#6b7280;font-family:Arial,sans-serif">${disclaimer}</div>`;
  return body.replace(/<\/body>/i, `${footer}</body>`);
}
