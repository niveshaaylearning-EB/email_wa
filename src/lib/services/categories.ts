import "server-only";
import Papa from "papaparse";
import type { MembershipSource, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { badRequest, conflict, notFound } from "@/lib/errors";
import type { CategoryCreate } from "@/lib/contracts";
import { normalizeEmail } from "@/lib/email";
import { normalizePhone } from "@/lib/phone";

export function slugify(name: string) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

async function uniqueSlug(name: string) {
  const base = slugify(name) || "category";
  let slug = base;
  for (let i = 2; await prisma.category.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;
  return slug;
}

export async function listCategories(opts: { q?: string; includeArchived?: boolean } = {}) {
  const cats = await prisma.category.findMany({
    where: {
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      ...(opts.q ? { OR: [{ name: { contains: opts.q, mode: "insensitive" } }, { description: { contains: opts.q, mode: "insensitive" } }] } : {}),
    },
    orderBy: [{ archivedAt: "asc" }, { priority: "asc" }, { name: "asc" }],
    include: {
      _count: { select: { memberships: { where: { removedAt: null } }, campaigns: true, rules: { where: { archivedAt: null } } } },
      templates: { where: { removedAt: null }, include: { template: { select: { id: true, name: true, channel: true, approvalStatus: true } } } },
    },
  });
  return cats.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    color: c.color,
    priority: c.priority,
    archivedAt: c.archivedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    memberCount: c._count.memberships,
    campaignCount: c._count.campaigns,
    ruleCount: c._count.rules,
    templates: c.templates.map((t) => ({ ...t.template, isDefault: t.isDefault })),
  }));
}
export type CategoryListItem = Awaited<ReturnType<typeof listCategories>>[number];

export async function createCategory(input: CategoryCreate, actor: AuditActor) {
  const dupe = await prisma.category.findFirst({ where: { archivedAt: null, name: { equals: input.name, mode: "insensitive" } } });
  if (dupe) throw conflict(`An active category named "${dupe.name}" already exists.`);
  const cat = await prisma.category.create({
    data: { name: input.name, description: input.description || null, color: input.color, priority: input.priority, slug: await uniqueSlug(input.name), createdById: actor.id },
  });
  await audit({ actor, action: "category.created", entityType: "category", entityId: cat.id, metadata: { name: cat.name } });
  return cat;
}

export async function updateCategory(id: string, input: Partial<CategoryCreate>, actor: AuditActor) {
  const existing = await prisma.category.findUnique({ where: { id } });
  if (!existing) throw notFound("Category");
  if (existing.archivedAt) throw badRequest("Archived categories cannot be edited. Restore it first.");
  if (input.name && input.name.toLowerCase() !== existing.name.toLowerCase()) {
    const dupe = await prisma.category.findFirst({ where: { archivedAt: null, id: { not: id }, name: { equals: input.name, mode: "insensitive" } } });
    if (dupe) throw conflict(`An active category named "${dupe.name}" already exists.`);
  }
  const cat = await prisma.category.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
    },
  });
  await audit({ actor, action: "category.updated", entityType: "category", entityId: id, metadata: { before: { name: existing.name, description: existing.description, color: existing.color, priority: existing.priority }, after: input } });
  return cat;
}

/**
 * Archive (never hard-delete): history, memberships and campaign references are preserved.
 * Blocked while a non-terminal campaign targets the category.
 */
export async function archiveCategory(id: string, actor: AuditActor) {
  const active = await prisma.campaignCategory.count({
    where: { categoryId: id, campaign: { status: { in: ["PENDING_APPROVAL", "APPROVED", "SCHEDULED", "QUEUED", "RUNNING", "PAUSED"] } } },
  });
  if (active > 0) throw conflict(`This category is used by ${active} active campaign(s). Complete or cancel them before archiving.`);
  const cat = await prisma.category.update({ where: { id }, data: { archivedAt: new Date() } });
  await audit({ actor, action: "category.archived", entityType: "category", entityId: id, metadata: { name: cat.name } });
  return cat;
}

export async function restoreCategory(id: string, actor: AuditActor) {
  const cat = await prisma.category.findUniqueOrThrow({ where: { id } });
  const dupe = await prisma.category.findFirst({ where: { archivedAt: null, id: { not: id }, name: { equals: cat.name, mode: "insensitive" } } });
  if (dupe) throw conflict(`Rename the active category "${dupe.name}" before restoring this one.`);
  await prisma.category.update({ where: { id }, data: { archivedAt: null } });
  await audit({ actor, action: "category.restored", entityType: "category", entityId: id });
}

export async function addMembers(
  args: { clientIds: string[]; categoryIds: string[]; source: MembershipSource; note?: string },
  actor: AuditActor,
) {
  const categories = await prisma.category.findMany({ where: { id: { in: args.categoryIds } } });
  if (categories.length !== new Set(args.categoryIds).size) throw notFound("One or more categories");
  const archived = categories.filter((c) => c.archivedAt);
  if (archived.length) throw badRequest(`Cannot add members to archived categories: ${archived.map((c) => c.name).join(", ")}`);
  const clients = await prisma.client.findMany({ where: { id: { in: args.clientIds } }, select: { id: true } });
  const validClientIds = clients.map((c) => c.id);

  const existing = await prisma.clientCategory.findMany({ where: { clientId: { in: validClientIds }, categoryId: { in: args.categoryIds } } });
  const key = (c: string, k: string) => `${c}:${k}`;
  const existingMap = new Map(existing.map((m) => [key(m.clientId, m.categoryId), m]));

  let added = 0;
  let alreadyMember = 0;
  const events: Prisma.MembershipEventCreateManyInput[] = [];
  const toCreate: Prisma.ClientCategoryCreateManyInput[] = [];
  const toReactivate: string[] = [];
  for (const clientId of validClientIds) {
    for (const categoryId of args.categoryIds) {
      const m = existingMap.get(key(clientId, categoryId));
      if (m && !m.removedAt) {
        alreadyMember += 1;
        continue;
      }
      if (m) toReactivate.push(m.id);
      else toCreate.push({ clientId, categoryId, source: args.source, addedById: actor.id });
      events.push({ clientId, categoryId, action: "ADDED", source: args.source, actorId: actor.id, note: args.note });
      added += 1;
    }
  }
  await prisma.$transaction(async (tx) => {
    if (toCreate.length) await tx.clientCategory.createMany({ data: toCreate, skipDuplicates: true });
    if (toReactivate.length) {
      await tx.clientCategory.updateMany({
        where: { id: { in: toReactivate } },
        data: { removedAt: null, removedById: null, source: args.source, ruleId: null, addedById: actor.id, addedAt: new Date() },
      });
    }
    if (events.length) await tx.membershipEvent.createMany({ data: events });
  });
  await audit({
    actor,
    action: "membership.added",
    entityType: "category",
    entityId: args.categoryIds.length === 1 ? args.categoryIds[0] : null,
    metadata: { categoryIds: args.categoryIds, clientCount: validClientIds.length, added, alreadyMember, source: args.source, unknownClients: args.clientIds.length - validClientIds.length },
  });
  return { added, alreadyMember, unknownClients: args.clientIds.length - validClientIds.length };
}

export async function removeMembers(args: { clientIds: string[]; categoryIds: string[]; note?: string }, actor: AuditActor) {
  const active = await prisma.clientCategory.findMany({
    where: { clientId: { in: args.clientIds }, categoryId: { in: args.categoryIds }, removedAt: null },
  });
  await prisma.$transaction(async (tx) => {
    await tx.clientCategory.updateMany({ where: { id: { in: active.map((m) => m.id) } }, data: { removedAt: new Date(), removedById: actor.id } });
    await tx.membershipEvent.createMany({
      data: active.map((m) => ({ clientId: m.clientId, categoryId: m.categoryId, action: "REMOVED" as const, source: m.source, actorId: actor.id, note: args.note })),
    });
  });
  await audit({ actor, action: "membership.removed", entityType: "category", entityId: args.categoryIds.length === 1 ? args.categoryIds[0] : null, metadata: { categoryIds: args.categoryIds, removed: active.length } });
  return { removed: active.length };
}

export interface CsvImportRow {
  line: number;
  input: string;
  status: "matched" | "already_member" | "not_found" | "ambiguous" | "invalid";
  clientId?: string;
  clientName?: string;
  message?: string;
}

/**
 * CSV membership import. Each row identifies an existing CRM client by zoho_crm_id, email or phone.
 * Clients are never created from CSV — Zoho CRM remains the source of client identity.
 */
export async function importMembershipCsv(args: { categoryId: string; csv: string; dryRun: boolean }, actor: AuditActor) {
  const category = await prisma.category.findUnique({ where: { id: args.categoryId } });
  if (!category || category.archivedAt) throw notFound("Active category");
  const parsed = Papa.parse<Record<string, string>>(args.csv.trim(), { header: true, skipEmptyLines: true, transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_") });
  const fields = parsed.meta.fields ?? [];
  const idCol = fields.find((f) => ["zoho_crm_id", "crm_id", "record_id", "id"].includes(f));
  const emailCol = fields.find((f) => ["email", "email_address", "e-mail"].includes(f));
  const phoneCol = fields.find((f) => ["phone", "mobile", "phone_number", "whatsapp"].includes(f));
  if (!idCol && !emailCol && !phoneCol) throw badRequest("CSV must have a header row with at least one of: zoho_crm_id, email, phone.");
  if (parsed.data.length > 50_000) throw badRequest("CSV is limited to 50,000 rows per import.");

  const rows: CsvImportRow[] = [];
  const crmIds = new Set<string>();
  const emails = new Set<string>();
  const phones = new Set<string>();
  const prepared = parsed.data.map((r, i) => {
    const crmId = idCol ? r[idCol]?.trim() : "";
    const email = emailCol ? normalizeEmail(r[emailCol]) : null;
    const phone = phoneCol ? normalizePhone(r[phoneCol])?.e164 ?? null : null;
    if (crmId) crmIds.add(crmId);
    if (email) emails.add(email);
    if (phone) phones.add(phone);
    return { line: i + 2, crmId, email, phone, raw: [crmId, emailCol ? r[emailCol] : "", phoneCol ? r[phoneCol] : ""].filter(Boolean).join(" / ") };
  });
  const candidates = await prisma.client.findMany({
    where: { deletedInCrmAt: null, OR: [{ zohoCrmId: { in: [...crmIds] } }, { emailNormalized: { in: [...emails] } }, { phoneE164: { in: [...phones] } }] },
    select: { id: true, zohoCrmId: true, emailNormalized: true, phoneE164: true, fullName: true, duplicateOfId: true },
  });
  const members = new Set(
    (await prisma.clientCategory.findMany({ where: { categoryId: args.categoryId, removedAt: null }, select: { clientId: true } })).map((m) => m.clientId),
  );
  const toAdd = new Set<string>();
  for (const p of prepared) {
    if (!p.crmId && !p.email && !p.phone) {
      rows.push({ line: p.line, input: p.raw, status: "invalid", message: "No valid CRM ID, email or phone" });
      continue;
    }
    let matches = p.crmId ? candidates.filter((c) => c.zohoCrmId === p.crmId) : [];
    if (!matches.length && p.email) matches = candidates.filter((c) => c.emailNormalized === p.email);
    if (!matches.length && p.phone) matches = candidates.filter((c) => c.phoneE164 === p.phone);
    const primaries = matches.filter((m) => !m.duplicateOfId);
    const resolved = primaries.length === 1 ? primaries : matches.length === 1 ? matches : null;
    if (!matches.length) rows.push({ line: p.line, input: p.raw, status: "not_found", message: "No CRM client matches" });
    else if (!resolved) rows.push({ line: p.line, input: p.raw, status: "ambiguous", message: `${matches.length} clients match — use zoho_crm_id` });
    else {
      const c = resolved[0];
      const already = members.has(c.id) || toAdd.has(c.id);
      rows.push({ line: p.line, input: p.raw, status: already ? "already_member" : "matched", clientId: c.id, clientName: c.fullName });
      if (!already) toAdd.add(c.id);
    }
  }
  const summary = {
    total: rows.length,
    matched: rows.filter((r) => r.status === "matched").length,
    alreadyMember: rows.filter((r) => r.status === "already_member").length,
    notFound: rows.filter((r) => r.status === "not_found").length,
    ambiguous: rows.filter((r) => r.status === "ambiguous").length,
    invalid: rows.filter((r) => r.status === "invalid").length,
  };
  if (!args.dryRun && toAdd.size) {
    await addMembers({ clientIds: [...toAdd], categoryIds: [args.categoryId], source: "CSV", note: "CSV import" }, actor);
  }
  await audit({ actor, action: args.dryRun ? "membership.csv_validated" : "membership.csv_imported", entityType: "category", entityId: args.categoryId, metadata: summary });
  return { summary, rows: rows.slice(0, 2000), applied: !args.dryRun };
}

export async function getCategoryDetail(id: string) {
  const cat = await prisma.category.findUnique({
    where: { id },
    include: {
      rules: { where: { archivedAt: null }, orderBy: { createdAt: "asc" } },
      templates: { where: { removedAt: null }, include: { template: true } },
      campaigns: {
        include: { campaign: { select: { id: true, name: true, status: true, channelMode: true, createdAt: true, completedAt: true } } },
        orderBy: { campaign: { createdAt: "desc" } },
        take: 50,
      },
      createdBy: { select: { name: true } },
    },
  });
  if (!cat) return null;
  const [memberCount, sourceBreakdown, events] = await Promise.all([
    prisma.clientCategory.count({ where: { categoryId: id, removedAt: null } }),
    prisma.clientCategory.groupBy({ by: ["source"], where: { categoryId: id, removedAt: null }, _count: true }),
    prisma.membershipEvent.findMany({
      where: { categoryId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { client: { select: { id: true, fullName: true } }, actor: { select: { name: true } } },
    }),
  ]);
  return { ...cat, memberCount, sourceBreakdown: Object.fromEntries(sourceBreakdown.map((s) => [s.source, s._count])), events };
}
