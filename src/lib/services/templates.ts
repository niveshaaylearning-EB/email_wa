import "server-only";
import { Prisma, type Template } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { badRequest, conflict, notFound } from "@/lib/errors";
import type { TemplateUpsert } from "@/lib/contracts";
import { stableHash } from "@/lib/crypto";
import {
  renderTemplate,
  validateTemplateDefinition,
  type RenderableTemplate,
  type TemplateVariable,
  type WhatsAppHeader,
} from "@/lib/domain/template-render";

export function toRenderable(t: Template): RenderableTemplate {
  return {
    id: t.id,
    channel: t.channel,
    name: t.name,
    providerTemplateId: t.providerTemplateId,
    language: t.language,
    subject: t.subject,
    body: t.body,
    header: (t.header as WhatsAppHeader | null) ?? null,
    variables: (t.variables as TemplateVariable[]) ?? [],
  };
}

type SnapshotSource = { [K in "channel" | "name" | "providerTemplateId" | "language" | "subject" | "senderName" | "body" | "header" | "buttons" | "variables" | "approvalStatus"]: unknown };

function contentSnapshot(t: SnapshotSource) {
  return {
    channel: t.channel,
    name: t.name,
    providerTemplateId: t.providerTemplateId,
    language: t.language,
    subject: t.subject,
    senderName: t.senderName,
    body: t.body,
    header: t.header,
    buttons: t.buttons,
    variables: t.variables,
    approvalStatus: t.approvalStatus,
  };
}

export async function listTemplates(opts: { channel?: "EMAIL" | "WHATSAPP"; categoryId?: string; q?: string; includeArchived?: boolean } = {}) {
  const rows = await prisma.template.findMany({
    where: {
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.categoryId ? { categories: { some: { categoryId: opts.categoryId, removedAt: null } } } : {}),
      ...(opts.q ? { OR: [{ name: { contains: opts.q, mode: "insensitive" } }, { providerTemplateId: { contains: opts.q, mode: "insensitive" } }] } : {}),
    },
    orderBy: [{ channel: "asc" }, { name: "asc" }],
    include: {
      categories: { where: { removedAt: null }, include: { category: { select: { id: true, name: true, color: true, archivedAt: true } } } },
      _count: { select: { assignments: true } },
    },
  });
  return rows.map((t) => ({
    ...t,
    issues: validateTemplateDefinition(toRenderable(t)),
    usageCount: t._count.assignments,
    categories: t.categories.map((c) => ({ ...c.category, isDefault: c.isDefault })),
  }));
}
export type TemplateListItem = Awaited<ReturnType<typeof listTemplates>>[number];

function dataFromInput(input: TemplateUpsert) {
  return {
    channel: input.channel,
    name: input.name,
    description: input.description || null,
    provider: input.channel === "EMAIL" ? ("ZOHO_MA" as const) : ("DOUBLETICK" as const),
    providerTemplateId: input.providerTemplateId || null,
    language: input.channel === "WHATSAPP" ? input.language || null : null,
    subject: input.channel === "EMAIL" ? input.subject || null : null,
    senderName: input.senderName || null,
    body: input.body,
    header: (input.channel === "WHATSAPP" && input.header ? input.header : null) as Prisma.InputJsonValue | undefined,
    variables: input.variables as Prisma.InputJsonValue,
    approvalStatus: input.approvalStatus,
  };
}

export async function createTemplate(input: TemplateUpsert, actor: AuditActor) {
  const data = dataFromInput(input);
  const issues = validateTemplateDefinition({ id: "new", ...data, header: input.header ?? null, variables: input.variables });
  if (data.approvalStatus === "APPROVED" && issues.some((i) => i.level === "error")) {
    throw badRequest("Fix template errors before marking it approved.", issues);
  }
  const t = await prisma.$transaction(async (tx) => {
    const created = await tx.template.create({ data: { ...data, header: data.header ?? undefined } });
    const snap = contentSnapshot(created);
    await tx.templateVersion.create({
      data: { templateId: created.id, version: 1, snapshot: snap as Prisma.InputJsonValue, contentHash: stableHash(snap), changeNote: input.changeNote ?? "Created", createdById: actor.id },
    });
    return created;
  });
  await audit({ actor, action: "template.created", entityType: "template", entityId: t.id, metadata: { name: t.name, channel: t.channel } });
  return t;
}

/** Any content change creates a new immutable version; frozen campaigns keep referencing their version. */
export async function updateTemplate(id: string, input: TemplateUpsert, actor: AuditActor) {
  const existing = await prisma.template.findUnique({ where: { id } });
  if (!existing) throw notFound("Template");
  if (existing.channel !== input.channel) throw badRequest("Template channel cannot be changed. Create a new template instead.");
  const data = dataFromInput(input);
  const issues = validateTemplateDefinition({ id, ...data, header: input.header ?? null, variables: input.variables });
  if (data.approvalStatus === "APPROVED" && issues.some((i) => i.level === "error")) throw badRequest("Fix template errors before marking it approved.", issues);
  const nextSnap = contentSnapshot({ ...existing, ...data, header: (data.header ?? null) as Prisma.JsonValue, buttons: existing.buttons });
  const changed = stableHash(nextSnap) !== stableHash(contentSnapshot(existing));
  const t = await prisma.$transaction(async (tx) => {
    const version = changed ? existing.currentVersion + 1 : existing.currentVersion;
    const updated = await tx.template.update({ where: { id }, data: { ...data, header: data.header ?? Prisma.DbNull, currentVersion: version } });
    if (changed) {
      await tx.templateVersion.create({
        data: { templateId: id, version, snapshot: nextSnap as Prisma.InputJsonValue, contentHash: stableHash(nextSnap), changeNote: input.changeNote ?? null, createdById: actor.id },
      });
    }
    return updated;
  });
  await audit({ actor, action: "template.updated", entityType: "template", entityId: id, metadata: { newVersion: changed ? t.currentVersion : null, approvalStatus: t.approvalStatus } });
  return t;
}

export async function archiveTemplate(id: string, actor: AuditActor) {
  const inUse = await prisma.campaignCategory.count({
    where: {
      OR: [{ emailTemplateId: id }, { whatsappTemplateId: id }],
      campaign: { status: { in: ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "QUEUED", "RUNNING", "PAUSED"] } },
    },
  });
  if (inUse) throw conflict(`Template is selected in ${inUse} open campaign(s).`);
  await prisma.template.update({ where: { id }, data: { archivedAt: new Date() } });
  await audit({ actor, action: "template.archived", entityType: "template", entityId: id });
}

export async function mapTemplateToCategory(args: { categoryId: string; templateId: string; isDefault: boolean }, actor: AuditActor) {
  const [cat, t] = await Promise.all([
    prisma.category.findUnique({ where: { id: args.categoryId } }),
    prisma.template.findUnique({ where: { id: args.templateId } }),
  ]);
  if (!cat || cat.archivedAt) throw notFound("Active category");
  if (!t || t.archivedAt) throw notFound("Active template");
  await prisma.$transaction(async (tx) => {
    if (args.isDefault) {
      await tx.categoryTemplate.updateMany({ where: { categoryId: args.categoryId, channel: t.channel }, data: { isDefault: false } });
    }
    await tx.categoryTemplate.upsert({
      where: { categoryId_templateId: { categoryId: args.categoryId, templateId: args.templateId } },
      create: { categoryId: args.categoryId, templateId: args.templateId, channel: t.channel, isDefault: args.isDefault, createdById: actor.id },
      update: { removedAt: null, isDefault: args.isDefault },
    });
  });
  await audit({ actor, action: "template.mapped", entityType: "category", entityId: args.categoryId, metadata: { templateId: args.templateId, channel: t.channel, isDefault: args.isDefault } });
}

export async function unmapTemplate(args: { categoryId: string; templateId: string }, actor: AuditActor) {
  await prisma.categoryTemplate.update({
    where: { categoryId_templateId: { categoryId: args.categoryId, templateId: args.templateId } },
    data: { removedAt: new Date(), isDefault: false },
  });
  await audit({ actor, action: "template.unmapped", entityType: "category", entityId: args.categoryId, metadata: { templateId: args.templateId } });
}

export async function testRender(id: string, opts: { clientId?: string }) {
  const t = await prisma.template.findUnique({ where: { id } });
  if (!t) throw notFound("Template");
  const client = opts.clientId ? await prisma.client.findUnique({ where: { id: opts.clientId } }) : null;
  const r = renderTemplate(toRenderable(t), { client: client ?? undefined, campaign: { name: "Sample campaign" } }, { useSamples: !client });
  return { ...r, issues: validateTemplateDefinition(toRenderable(t)), usedClient: client ? { id: client.id, fullName: client.fullName } : null };
}

export async function getTemplateDetail(id: string) {
  return prisma.template.findUnique({
    where: { id },
    include: {
      versions: { orderBy: { version: "desc" }, include: { createdBy: { select: { name: true } } } },
      categories: { include: { category: { select: { id: true, name: true, color: true, archivedAt: true } } } },
    },
  });
}

/** Templates authorised for a category+channel (approved, not archived, mapping active). */
export async function authorizedTemplates(categoryIds: string[]) {
  const rows = await prisma.categoryTemplate.findMany({
    where: { categoryId: { in: categoryIds }, removedAt: null, template: { archivedAt: null } },
    include: { template: true },
  });
  return rows;
}
