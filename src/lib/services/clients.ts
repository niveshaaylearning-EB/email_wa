import "server-only";
import type { Prisma, Channel } from "@prisma/client";
import { prisma } from "@/lib/db";
import type { ClientListQuery } from "@/lib/contracts";
import { audit, type AuditActor } from "@/lib/audit";
import { notFound, conflict } from "@/lib/errors";
import { normalizeEmail } from "@/lib/email";
import { formatPhoneInternational, normalizePhone } from "@/lib/phone";

export function buildClientWhere(q: Partial<ClientListQuery>): Prisma.ClientWhereInput {
  const and: Prisma.ClientWhereInput[] = [];
  if (q.q) {
    const term = q.q.trim();
    const digits = term.replace(/\D/g, "");
    and.push({
      OR: [
        { fullName: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
        { zohoCrmId: { contains: term } },
        ...(digits.length >= 4 ? [{ phoneE164: { contains: digits } }] : []),
      ],
    });
  }
  if (q.categoryId) and.push({ memberships: { some: { categoryId: q.categoryId, removedAt: null } } });
  if (q.uncategorized) and.push({ memberships: { none: { removedAt: null } } });
  if (q.contact === "missing_email") and.push({ emailNormalized: null });
  if (q.contact === "missing_phone") and.push({ phoneRaw: null });
  if (q.contact === "invalid_phone") and.push({ phoneRaw: { not: null }, phoneValid: false });
  if (q.contact === "complete") and.push({ emailNormalized: { not: null }, phoneValid: true });
  if (q.status) and.push({ crmStatus: { equals: q.status, mode: "insensitive" } });
  if (q.duplicates) and.push({ OR: [{ duplicateOfId: { not: null } }, { duplicates: { some: {} } }] });
  if (q.consent === "email_revoked") and.push({ OR: [{ crmEmailOptOut: true }, { consents: { some: { channel: "EMAIL", status: "REVOKED" } } }] });
  if (q.consent === "whatsapp_granted") and.push({ consents: { some: { channel: "WHATSAPP", status: "GRANTED" } } });
  if (q.consent === "whatsapp_missing") and.push({ consents: { none: { channel: "WHATSAPP" } } });
  return and.length ? { AND: and } : {};
}

/** Latest consent per (client, channel) — consents are append-only. */
export async function currentConsents(clientIds: string[]) {
  if (!clientIds.length) return new Map<string, Partial<Record<Channel, { status: "GRANTED" | "REVOKED"; id: string; effectiveAt: Date }>>>();
  const rows = await prisma.$queryRaw<{ id: string; client_id: string; channel: Channel; status: "GRANTED" | "REVOKED"; effective_at: Date }[]>`
    SELECT DISTINCT ON (client_id, channel) id, client_id, channel, status, effective_at
    FROM consents
    WHERE client_id = ANY(${clientIds})
    ORDER BY client_id, channel, effective_at DESC, created_at DESC`;
  const map = new Map<string, Partial<Record<Channel, { status: "GRANTED" | "REVOKED"; id: string; effectiveAt: Date }>>>();
  for (const r of rows) {
    const entry = map.get(r.client_id) ?? {};
    entry[r.channel] = { status: r.status, id: r.id, effectiveAt: r.effective_at };
    map.set(r.client_id, entry);
  }
  return map;
}

export async function listClients(q: ClientListQuery) {
  const where = buildClientWhere(q);
  const orderBy: Prisma.ClientOrderByWithRelationInput =
    q.sort === "updated" ? { crmModifiedAt: q.dir } : q.sort === "email" ? { email: q.dir } : q.sort === "categories" ? { memberships: { _count: q.dir } } : { fullName: q.dir };
  const [total, rows] = await Promise.all([
    prisma.client.count({ where }),
    prisma.client.findMany({
      where,
      orderBy: [orderBy, { id: "asc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        memberships: { where: { removedAt: null, category: { archivedAt: null } }, include: { category: { select: { id: true, name: true, color: true } } } },
        _count: { select: { duplicates: true } },
      },
    }),
  ]);
  const consents = await currentConsents(rows.map((r) => r.id));
  const suppressed = await activeSuppressionSet(rows.flatMap((r) => [r.emailNormalized, r.phoneE164].filter((x): x is string => !!x)));
  return {
    total,
    page: q.page,
    pageSize: q.pageSize,
    rows: rows.map((r) => ({
      id: r.id,
      zohoCrmId: r.zohoCrmId,
      fullName: r.fullName,
      email: r.email,
      emailValid: !!r.emailNormalized,
      phoneE164: r.phoneE164,
      phoneDisplay: r.phoneE164 ? formatPhoneInternational(r.phoneE164) : null,
      phoneRaw: r.phoneRaw,
      phoneValid: r.phoneValid,
      phoneCountry: r.phoneCountry,
      city: r.city,
      crmStatus: r.crmStatus,
      crmModifiedAt: r.crmModifiedAt?.toISOString() ?? null,
      isMock: r.isMock,
      deletedInCrm: !!r.deletedInCrmAt,
      isDuplicate: !!r.duplicateOfId,
      hasDuplicates: r._count.duplicates > 0,
      categories: r.memberships.map((m) => m.category),
      emailConsent: r.crmEmailOptOut ? "REVOKED" : consents.get(r.id)?.EMAIL?.status ?? null,
      whatsappConsent: consents.get(r.id)?.WHATSAPP?.status ?? null,
      suppressed: [r.emailNormalized, r.phoneE164].some((v) => v && suppressed.has(v)),
    })),
  };
}
export type ClientRow = Awaited<ReturnType<typeof listClients>>["rows"][number];

export async function activeSuppressionSet(values: string[]) {
  if (!values.length) return new Set<string>();
  const rows = await prisma.suppressionEntry.findMany({ where: { identifierValue: { in: values }, liftedAt: null }, select: { identifierValue: true } });
  return new Set(rows.map((r) => r.identifierValue));
}

export async function getClientProfile(id: string) {
  const client = await prisma.client.findUnique({
    where: { id },
    include: {
      memberships: { include: { category: true }, orderBy: { addedAt: "desc" } },
      membershipEvents: { include: { category: { select: { name: true, color: true } }, actor: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 100 },
      consents: { orderBy: { effectiveAt: "desc" } },
      suppressions: { orderBy: { createdAt: "desc" } },
      deliveries: {
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          campaign: { select: { id: true, name: true } },
          assignment: { select: { template: { select: { name: true } }, category: { select: { name: true, color: true } } } },
          events: { orderBy: { occurredAt: "asc" } },
        },
      },
      duplicateOf: { select: { id: true, fullName: true, zohoCrmId: true } },
      duplicates: { select: { id: true, fullName: true, zohoCrmId: true } },
    },
  });
  if (!client) return null;
  const identifierSuppressions = await prisma.suppressionEntry.findMany({
    where: { identifierValue: { in: [client.emailNormalized, client.phoneE164].filter((x): x is string => !!x) } },
    orderBy: { createdAt: "desc" },
  });
  const possibleDuplicates = client.phoneE164
    ? await prisma.client.findMany({ where: { phoneE164: client.phoneE164, id: { not: client.id } }, select: { id: true, fullName: true, zohoCrmId: true, email: true } })
    : [];
  return { ...client, identifierSuppressions, possibleDuplicates };
}

export async function recordConsent(
  input: { clientId: string; channel: Channel; status: "GRANTED" | "REVOKED"; source: "MANUAL" | "CLIENT_REQUEST" | "CSV" | "PROVIDER_UNSUBSCRIBE" | "CRM"; evidence: string },
  actor: AuditActor | null,
) {
  const client = await prisma.client.findUnique({ where: { id: input.clientId } });
  if (!client) throw notFound("Client");
  const row = await prisma.consent.create({ data: { ...input, recordedById: actor?.id } });
  await audit({ actor, action: `consent.${input.status.toLowerCase()}`, entityType: "client", entityId: input.clientId, metadata: { channel: input.channel, source: input.source } });
  return row;
}

export async function addSuppression(
  input: { channel: Channel | null; identifierType: "EMAIL" | "PHONE"; identifierValue: string; reason: Prisma.SuppressionEntryCreateInput["reason"]; note?: string; source?: string },
  actor: AuditActor | null,
) {
  const value = input.identifierType === "EMAIL" ? normalizeEmail(input.identifierValue) : normalizePhone(input.identifierValue)?.e164;
  if (!value) throw conflict(`"${input.identifierValue}" is not a valid ${input.identifierType === "EMAIL" ? "email" : "phone number"}.`);
  const existing = await prisma.suppressionEntry.findFirst({ where: { identifierType: input.identifierType, identifierValue: value, channel: input.channel, liftedAt: null } });
  if (existing) return existing;
  const client = await prisma.client.findFirst({ where: input.identifierType === "EMAIL" ? { emailNormalized: value } : { phoneE164: value }, select: { id: true } });
  const row = await prisma.suppressionEntry.create({
    data: {
      channel: input.channel,
      identifierType: input.identifierType,
      identifierValue: value,
      reason: input.reason,
      note: input.note,
      source: input.source ?? "dashboard",
      clientId: client?.id,
      createdById: actor?.id,
    },
  });
  await audit({ actor, action: "suppression.added", entityType: "suppression", entityId: row.id, metadata: { channel: input.channel, identifierType: input.identifierType, reason: input.reason } });
  return row;
}

export async function liftSuppression(id: string, actor: AuditActor) {
  const row = await prisma.suppressionEntry.update({ where: { id }, data: { liftedAt: new Date(), liftedById: actor.id } });
  await audit({ actor, action: "suppression.lifted", entityType: "suppression", entityId: id });
  return row;
}

export async function exportClientsCsv(q: Partial<ClientListQuery>) {
  const rows = await prisma.client.findMany({
    where: buildClientWhere(q),
    orderBy: { fullName: "asc" },
    take: 100_000,
    include: { memberships: { where: { removedAt: null }, include: { category: { select: { name: true } } } } },
  });
  const header = ["zoho_crm_id", "name", "email", "phone_e164", "country", "city", "crm_status", "categories", "crm_modified_at"];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    // Neutralise spreadsheet formula injection.
    const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = rows.map((r) =>
    [r.zohoCrmId, r.fullName, r.email, r.phoneE164, r.phoneCountry, r.city, r.crmStatus, r.memberships.map((m) => m.category.name).join("; "), r.crmModifiedAt?.toISOString()]
      .map(esc)
      .join(","),
  );
  return [header.join(","), ...lines].join("\n");
}

export function csvEscape(v: unknown) {
  const s = v === null || v === undefined ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
