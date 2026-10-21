import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { listIntegrationsForUi } from "./integrations";

/**
 * All metrics are computed from recorded deliveries/events. "Accepted" (provider API accepted)
 * is reported separately from "delivered". Email per-recipient delivery is not exposed by Zoho MA,
 * so email "delivered" comes only from the campaign-level report; per-recipient we show sent/bounced/opened/clicked.
 * Simulated (MOCK) deliveries are counted separately and flagged so they're never mistaken for real data.
 */

export interface DateRange {
  from: Date;
  to: Date;
}

export function defaultRange(days = 30): DateRange {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400_000);
  return { from, to };
}

interface Counts {
  total: number;
  submitted: number;
  accepted: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  opened: number;
  clicked: number;
  dryRun: number;
  cancelled: number;
}

const zero = (): Counts => ({ total: 0, submitted: 0, accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0, opened: 0, clicked: 0, dryRun: 0, cancelled: 0 });

function countsFromRows(rows: { status: string; n: bigint; opened: bigint; clicked: bigint; reached_accept: bigint; reached_sent: bigint; reached_delivered: bigint }[]): Counts {
  const c = zero();
  for (const r of rows) {
    const n = Number(r.n);
    c.total += n;
    c.opened += Number(r.opened);
    c.clicked += Number(r.clicked);
    c.accepted += Number(r.reached_accept);
    c.sent += Number(r.reached_sent);
    c.delivered += Number(r.reached_delivered);
    if (r.status === "READ") c.read += n;
    if (r.status === "FAILED" || r.status === "BOUNCED") c.failed += n;
    if (r.status === "DRY_RUN") c.dryRun += n;
    if (r.status === "CANCELLED") c.cancelled += n;
    if (!["PENDING", "QUEUED", "DRY_RUN", "CANCELLED"].includes(r.status)) c.submitted += n;
  }
  return c;
}

async function deliveryCounts(where: Prisma.Sql) {
  const rows = await prisma.$queryRaw<
    { channel: "EMAIL" | "WHATSAPP"; simulated: boolean; status: string; n: bigint; opened: bigint; clicked: bigint; reached_accept: bigint; reached_sent: bigint; reached_delivered: bigint }[]
  >`
    SELECT channel, is_simulated AS simulated, status::text AS status, COUNT(*)::bigint AS n,
      COUNT(opened_at)::bigint AS opened, COUNT(clicked_at)::bigint AS clicked,
      COUNT(accepted_at)::bigint AS reached_accept,
      COUNT(sent_at)::bigint AS reached_sent,
      COUNT(delivered_at)::bigint AS reached_delivered
    FROM message_deliveries d
    WHERE ${where}
    GROUP BY channel, is_simulated, status`;
  const out = { EMAIL: zero(), WHATSAPP: zero(), simulated: 0, real: 0 };
  for (const ch of ["EMAIL", "WHATSAPP"] as const) out[ch] = countsFromRows(rows.filter((r) => r.channel === ch));
  for (const r of rows) {
    if (r.simulated) out.simulated += Number(r.n);
    else out.real += Number(r.n);
  }
  return out;
}

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

export async function getOverview(range = defaultRange(30)) {
  const inRange = Prisma.sql`d.created_at >= ${range.from} AND d.created_at <= ${range.to}`;
  const [clients, categories, assigned, pendingApprovals, scheduled, campaignStatus, counts, integrations, lastSync, mockClients] = await Promise.all([
    prisma.client.count({ where: { deletedInCrmAt: null } }),
    prisma.category.count({ where: { archivedAt: null } }),
    prisma.client.count({ where: { deletedInCrmAt: null, memberships: { some: { removedAt: null, category: { archivedAt: null } } } } }),
    prisma.campaign.count({ where: { status: "PENDING_APPROVAL", deletedAt: null } }),
    prisma.campaign.count({ where: { status: "SCHEDULED", deletedAt: null } }),
    prisma.campaign.groupBy({ by: ["status"], where: { deletedAt: null }, _count: true }),
    deliveryCounts(inRange),
    listIntegrationsForUi(),
    prisma.syncRun.findFirst({ where: { provider: "ZOHO_CRM" }, orderBy: { startedAt: "desc" } }),
    prisma.client.count({ where: { isMock: true } }),
  ]);
  const sentCampaigns = await prisma.$queryRaw<{ channel: string; n: bigint }[]>`
    SELECT d.channel::text AS channel, COUNT(DISTINCT d.campaign_id)::bigint AS n
    FROM message_deliveries d
    WHERE d.status NOT IN ('DRY_RUN','CANCELLED','PENDING','QUEUED') AND ${inRange}
    GROUP BY d.channel`;
  const sc = Object.fromEntries(sentCampaigns.map((r) => [r.channel, Number(r.n)]));

  return {
    range,
    kpis: {
      totalClients: clients,
      totalCategories: categories,
      clientsAssigned: assigned,
      emailCampaignsSent: sc.EMAIL ?? 0,
      whatsappCampaignsSent: sc.WHATSAPP ?? 0,
      whatsappDelivered: counts.WHATSAPP.delivered,
      emailSent: counts.EMAIL.sent,
      failed: counts.EMAIL.failed + counts.WHATSAPP.failed,
      pendingApprovals,
      scheduled,
      emailOpenRate: pct(counts.EMAIL.opened, counts.EMAIL.sent),
      whatsappReadRate: pct(counts.WHATSAPP.read, counts.WHATSAPP.delivered),
      whatsappDeliveryRate: pct(counts.WHATSAPP.delivered, counts.WHATSAPP.accepted),
    },
    counts,
    campaignStatus: Object.fromEntries(campaignStatus.map((s) => [s.status, s._count])),
    integrations: integrations.map((i) => ({ provider: i.provider, label: i.label, mode: i.mode, status: i.status, lastSuccessAt: i.lastSuccessAt, lastError: i.lastError, lastErrorAt: i.lastErrorAt })),
    lastCrmSync: lastSync ? { at: lastSync.finishedAt ?? lastSync.startedAt, status: lastSync.status, stats: lastSync.stats } : null,
    dataQuality: { includesSimulated: counts.simulated > 0, simulatedMessages: counts.simulated, realMessages: counts.real, mockClients },
  };
}

export async function getTrends(range = defaultRange(30), granularity: "day" | "month" = "day") {
  const fmt = granularity === "day" ? "YYYY-MM-DD" : "YYYY-MM";
  const rows = await prisma.$queryRaw<{ bucket: string; channel: string; accepted: bigint; delivered: bigint; read: bigint; failed: bigint; opened: bigint; total: bigint }[]>`
    SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', ${fmt}) AS bucket, channel::text AS channel,
      COUNT(*)::bigint AS total,
      COUNT(accepted_at)::bigint AS accepted,
      COUNT(delivered_at)::bigint AS delivered,
      COUNT(read_at)::bigint AS read,
      COUNT(*) FILTER (WHERE status IN ('FAILED','BOUNCED'))::bigint AS failed,
      COUNT(opened_at)::bigint AS opened
    FROM message_deliveries
    WHERE created_at >= ${range.from} AND created_at <= ${range.to} AND status NOT IN ('DRY_RUN','CANCELLED')
    GROUP BY 1, 2 ORDER BY 1`;
  const buckets = new Map<string, Record<string, number | string>>();
  // Pre-fill empty buckets so charts have continuous axes.
  const cursor = new Date(range.from);
  while (cursor <= range.to) {
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", ...(granularity === "day" ? { day: "2-digit" } : {}) }).format(cursor);
    buckets.set(key, { bucket: key, emailTotal: 0, whatsappTotal: 0, delivered: 0, read: 0, failed: 0, opened: 0, accepted: 0 });
    if (granularity === "day") cursor.setUTCDate(cursor.getUTCDate() + 1);
    else cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  for (const r of rows) {
    const b = buckets.get(r.bucket) ?? { bucket: r.bucket, emailTotal: 0, whatsappTotal: 0, delivered: 0, read: 0, failed: 0, opened: 0, accepted: 0 };
    if (r.channel === "EMAIL") b.emailTotal = Number(b.emailTotal) + Number(r.total);
    else b.whatsappTotal = Number(b.whatsappTotal) + Number(r.total);
    b.delivered = Number(b.delivered) + Number(r.delivered);
    b.read = Number(b.read) + Number(r.read);
    b.failed = Number(b.failed) + Number(r.failed);
    b.opened = Number(b.opened) + Number(r.opened);
    b.accepted = Number(b.accepted) + Number(r.accepted);
    buckets.set(r.bucket, b);
  }
  return [...buckets.values()];
}

export async function getCategoryPerformance(range = defaultRange(90)) {
  const rows = await prisma.$queryRaw<{ id: string; name: string; color: string; total: bigint; accepted: bigint; delivered: bigint; read: bigint; failed: bigint; opened: bigint; clicked: bigint }[]>`
    SELECT c.id, c.name, c.color,
      COUNT(d.id)::bigint AS total,
      COUNT(d.accepted_at)::bigint AS accepted,
      COUNT(d.delivered_at)::bigint AS delivered,
      COUNT(d.read_at)::bigint AS read,
      COUNT(d.id) FILTER (WHERE d.status IN ('FAILED','BOUNCED'))::bigint AS failed,
      COUNT(d.opened_at)::bigint AS opened,
      COUNT(d.clicked_at)::bigint AS clicked
    FROM categories c
    JOIN campaign_message_assignments a ON a.category_id = c.id
    JOIN message_deliveries d ON d.assignment_id = a.id
    WHERE d.created_at >= ${range.from} AND d.created_at <= ${range.to} AND d.status NOT IN ('DRY_RUN','CANCELLED')
    GROUP BY c.id, c.name, c.color
    ORDER BY total DESC`;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    color: r.color,
    total: Number(r.total),
    accepted: Number(r.accepted),
    delivered: Number(r.delivered),
    read: Number(r.read),
    failed: Number(r.failed),
    opened: Number(r.opened),
    clicked: Number(r.clicked),
  }));
}

export async function getCampaignAnalytics(campaignId: string) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { snapshot: true, categories: { include: { category: true } } },
  });
  if (!campaign) return null;
  const [recipientCounts, exclusionRows, assignmentCounts, counts, perCategory, failures] = await Promise.all([
    prisma.campaignRecipient.groupBy({ by: ["status"], where: { campaignId }, _count: true }),
    prisma.$queryRaw<{ reason: string; n: bigint }[]>`
      SELECT unnest(exclusion_reasons)::text AS reason, COUNT(*)::bigint AS n FROM campaign_recipients WHERE campaign_id = ${campaignId} GROUP BY 1 ORDER BY 2 DESC`,
    prisma.campaignMessageAssignment.groupBy({ by: ["status", "channel"], where: { campaignId }, _count: true }),
    deliveryCounts(Prisma.sql`d.campaign_id = ${campaignId}`),
    prisma.$queryRaw<{ category_id: string; channel: string; total: bigint; delivered: bigint; read: bigint; failed: bigint; opened: bigint; accepted: bigint }[]>`
      SELECT a.category_id, d.channel::text AS channel, COUNT(*)::bigint AS total, COUNT(d.accepted_at)::bigint AS accepted,
        COUNT(d.delivered_at)::bigint AS delivered, COUNT(d.read_at)::bigint AS read,
        COUNT(*) FILTER (WHERE d.status IN ('FAILED','BOUNCED'))::bigint AS failed, COUNT(d.opened_at)::bigint AS opened
      FROM message_deliveries d JOIN campaign_message_assignments a ON a.id = d.assignment_id
      WHERE d.campaign_id = ${campaignId} GROUP BY 1, 2`,
    prisma.messageDelivery.groupBy({ by: ["failureCode"], where: { campaignId, status: { in: ["FAILED", "BOUNCED"] } }, _count: true }),
  ]);
  const recipients = Object.fromEntries(recipientCounts.map((r) => [r.status, r._count])) as Record<string, number>;
  const planned = assignmentCounts.filter((a) => a.status === "PLANNED").reduce((n, a) => n + a._count, 0);
  const deliveriesTotal = counts.EMAIL.total + counts.WHATSAPP.total;
  const groups = ((campaign.providerRefs as { emailGroups?: { report?: Record<string, unknown>; status?: string; listKey?: string; campaignKey?: string; expected?: number; verifiedCount?: number | null }[] })?.emailGroups ?? []);
  return {
    campaign,
    funnel: {
      intended: (recipients.ELIGIBLE ?? 0) + (recipients.EXCLUDED ?? 0) + (recipients.NEEDS_REVIEW ?? 0),
      eligible: recipients.ELIGIBLE ?? 0,
      excluded: recipients.EXCLUDED ?? 0,
      plannedMessages: planned,
      queued: deliveriesTotal,
      submitted: counts.EMAIL.submitted + counts.WHATSAPP.submitted,
      accepted: counts.EMAIL.accepted + counts.WHATSAPP.accepted,
      delivered: counts.WHATSAPP.delivered,
      read: counts.WHATSAPP.read,
      emailSent: counts.EMAIL.sent,
      opened: counts.EMAIL.opened,
      clicked: counts.EMAIL.clicked,
      failed: counts.EMAIL.failed + counts.WHATSAPP.failed,
      dryRun: counts.EMAIL.dryRun + counts.WHATSAPP.dryRun,
      cancelled: counts.EMAIL.cancelled + counts.WHATSAPP.cancelled,
    },
    counts,
    exclusions: exclusionRows.map((r) => ({ reason: r.reason, count: Number(r.n) })),
    perCategory: perCategory.map((r) => ({ categoryId: r.category_id, channel: r.channel, total: Number(r.total), accepted: Number(r.accepted), delivered: Number(r.delivered), read: Number(r.read), failed: Number(r.failed), opened: Number(r.opened) })),
    failures: failures.map((f) => ({ code: f.failureCode ?? "UNKNOWN", count: f._count })),
    reconciliation: {
      plannedAssignments: planned,
      deliveriesCreated: deliveriesTotal,
      missingDeliveries: Math.max(0, planned - deliveriesTotal),
      emailGroups: groups.map((g, i) => ({ index: i, status: g.status ?? "pending", listKey: g.listKey, campaignKey: g.campaignKey, expected: g.expected, verifiedCount: g.verifiedCount, providerReport: g.report ?? null })),
    },
  };
}

export async function listCampaignRecipients(campaignId: string, opts: { page: number; pageSize: number; status?: string; channel?: string; q?: string }) {
  const where: Prisma.MessageDeliveryWhereInput = {
    campaignId,
    ...(opts.status ? { status: opts.status as Prisma.EnumDeliveryStatusFilter["equals"] } : {}),
    ...(opts.channel ? { channel: opts.channel as "EMAIL" | "WHATSAPP" } : {}),
    ...(opts.q ? { client: { OR: [{ fullName: { contains: opts.q, mode: "insensitive" } }, { email: { contains: opts.q, mode: "insensitive" } }] } } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.messageDelivery.count({ where }),
    prisma.messageDelivery.findMany({
      where,
      orderBy: { createdAt: "asc" },
      skip: (opts.page - 1) * opts.pageSize,
      take: opts.pageSize,
      include: {
        client: { select: { id: true, fullName: true } },
        assignment: { select: { category: { select: { name: true, color: true } }, template: { select: { name: true } }, recipient: { select: { contactSnapshot: true } } } },
        events: { orderBy: { occurredAt: "asc" } },
      },
    }),
  ]);
  return { total, rows };
}

export async function exportCampaignReportCsv(campaignId: string) {
  const rows = await prisma.campaignRecipient.findMany({
    where: { campaignId },
    include: {
      client: { select: { zohoCrmId: true } },
      assignments: { include: { delivery: true, category: { select: { name: true } }, template: { select: { name: true } }, templateVersion: { select: { version: true } } } },
    },
  });
  const { csvEscape } = await import("./clients");
  const header = ["zoho_crm_id", "name", "recipient_status", "exclusion_reasons", "channel", "category", "template", "template_version", "assignment_status", "delivery_status", "provider_message_id", "accepted_at", "sent_at", "delivered_at", "read_at", "opened_at", "clicked_at", "failed_at", "failure_code", "failure_reason", "simulated", "dry_run"];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    const snap = r.contactSnapshot as { fullName?: string };
    const base = [r.client.zohoCrmId, snap.fullName, r.status, r.exclusionReasons.join("|")];
    if (!r.assignments.length) lines.push([...base, "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""].map(csvEscape).join(","));
    for (const a of r.assignments) {
      const d = a.delivery;
      lines.push(
        [
          ...base,
          a.channel,
          a.category.name,
          a.template.name,
          a.templateVersion?.version,
          a.status,
          d?.status,
          d?.providerMessageId,
          d?.acceptedAt?.toISOString(),
          d?.sentAt?.toISOString(),
          d?.deliveredAt?.toISOString(),
          d?.readAt?.toISOString(),
          d?.openedAt?.toISOString(),
          d?.clickedAt?.toISOString(),
          d?.failedAt?.toISOString(),
          d?.failureCode,
          d?.failureReason,
          d?.isSimulated ? "yes" : "no",
          d?.isDryRun ? "yes" : "no",
        ]
          .map(csvEscape)
          .join(","),
      );
    }
  }
  return lines.join("\n");
}
