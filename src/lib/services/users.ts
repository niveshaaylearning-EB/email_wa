import "server-only";
import type { Prisma, RoleKey } from "@prisma/client";
import { prisma } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { hashPassword } from "@/lib/auth/session";
import { badRequest, conflict } from "@/lib/errors";
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from "@/lib/auth/permissions";
import { normalizePhone } from "@/lib/phone";
import { normalizeEmail } from "@/lib/email";

export async function ensureRoles() {
  for (const key of Object.keys(ROLE_LABELS) as RoleKey[]) {
    await prisma.role.upsert({ where: { key }, create: { key, name: ROLE_LABELS[key], description: ROLE_DESCRIPTIONS[key] }, update: { name: ROLE_LABELS[key], description: ROLE_DESCRIPTIONS[key] } });
  }
}

export async function listUsers() {
  return prisma.user.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, name: true, isActive: true, lastLoginAt: true, createdAt: true, role: { select: { key: true, name: true } } },
  });
}

export async function createUser(input: { name: string; email: string; role: RoleKey; password: string }, actor: AuditActor) {
  await ensureRoles();
  if (await prisma.user.findUnique({ where: { email: input.email } })) throw conflict("A user with this email already exists.");
  const role = await prisma.role.findUniqueOrThrow({ where: { key: input.role } });
  const u = await prisma.user.create({ data: { name: input.name, email: input.email, roleId: role.id, passwordHash: await hashPassword(input.password) } });
  await audit({ actor, action: "user.created", entityType: "user", entityId: u.id, metadata: { email: u.email, role: input.role } });
  return { id: u.id };
}

export async function updateUser(id: string, input: { role?: RoleKey; isActive?: boolean; name?: string }, actor: AuditActor) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id }, include: { role: true } });
  const losingAdmin = user.role.key === "ADMIN" && ((input.role && input.role !== "ADMIN") || input.isActive === false);
  if (losingAdmin) {
    const admins = await prisma.user.count({ where: { role: { key: "ADMIN" }, isActive: true, deletedAt: null } });
    if (admins <= 1) throw badRequest("At least one active administrator is required.");
  }
  if (id === actor.id && input.isActive === false) throw badRequest("You cannot deactivate your own account.");
  const data: Prisma.UserUpdateInput = {};
  if (input.name) data.name = input.name;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.role) data.role = { connect: { key: input.role } };
  await prisma.user.update({ where: { id }, data });
  if (input.isActive === false || input.role) await prisma.session.deleteMany({ where: { userId: id } });
  await audit({ actor, action: "user.updated", entityType: "user", entityId: id, metadata: { before: { role: user.role.key, isActive: user.isActive }, after: input } });
}

export async function listTestRecipients() {
  return prisma.internalTestRecipient.findMany({ where: { isActive: true }, orderBy: { name: "asc" } });
}

export async function addTestRecipient(input: { name: string; email?: string; phone?: string }, actor: AuditActor) {
  const email = input.email ? normalizeEmail(input.email) : null;
  const phone = input.phone ? normalizePhone(input.phone) : null;
  if (input.email && !email) throw badRequest("Invalid email.");
  if (input.phone && !phone?.valid) throw badRequest("Invalid phone number.");
  if (!email && !phone) throw badRequest("Provide an email or phone number.");
  const r = await prisma.internalTestRecipient.create({ data: { name: input.name, email, phoneE164: phone?.e164 ?? null } });
  await audit({ actor, action: "test_recipient.added", entityType: "test_recipient", entityId: r.id, metadata: { name: r.name } });
  return r;
}

export async function removeTestRecipient(id: string, actor: AuditActor) {
  await prisma.internalTestRecipient.update({ where: { id }, data: { isActive: false } });
  await audit({ actor, action: "test_recipient.removed", entityType: "test_recipient", entityId: id });
}

export async function queryAudit(opts: { q?: string; entityType?: string; campaignId?: string; actorId?: string; page: number; pageSize: number }) {
  const where: Prisma.AuditLogWhereInput = {
    ...(opts.entityType ? { entityType: opts.entityType } : {}),
    ...(opts.campaignId ? { campaignId: opts.campaignId } : {}),
    ...(opts.actorId ? { actorId: opts.actorId } : {}),
    ...(opts.q ? { OR: [{ action: { contains: opts.q, mode: "insensitive" } }, { actorEmail: { contains: opts.q, mode: "insensitive" } }, { entityId: { contains: opts.q } }] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (opts.page - 1) * opts.pageSize, take: opts.pageSize }),
  ]);
  return { total, rows };
}
