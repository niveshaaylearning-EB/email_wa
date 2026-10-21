import "server-only";
import type { Prisma, SyncType } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getCrmProvider } from "@/lib/providers/registry";
import type { CrmContact } from "@/lib/providers/types";
import { normalizePhone } from "@/lib/phone";
import { normalizeEmail } from "@/lib/email";
import { audit, type AuditActor } from "@/lib/audit";
import { conflict } from "@/lib/errors";
import { evaluateAllRules } from "./rules";

export interface SyncStats {
  fetched: number;
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  invalidPhones: number;
  missingEmail: number;
  duplicatesFlagged: number;
  pages: number;
}

/** Map a CRM contact onto client columns. Memberships are deliberately absent. */
export function contactToClientData(c: CrmContact, isMock: boolean) {
  const phoneSource = c.mobile ?? c.phone;
  const phone = normalizePhone(phoneSource);
  const email = normalizeEmail(c.email);
  const fullName = c.fullName ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || "(no name)");
  return {
    firstName: c.firstName,
    lastName: c.lastName,
    fullName,
    email: c.email,
    emailNormalized: email,
    secondaryEmail: c.secondaryEmail,
    phoneRaw: phoneSource,
    phoneE164: phone?.e164 ?? null,
    phoneCountry: phone?.country ?? null,
    phoneCountryCode: phone?.countryCode ?? null,
    phoneValid: phone?.valid ?? false,
    crmStatus: c.status,
    crmOwner: c.owner,
    city: c.city,
    crmEmailOptOut: c.emailOptOut,
    crmFields: c.extra as Prisma.InputJsonValue,
    crmModifiedAt: c.modifiedTime ? new Date(c.modifiedTime) : null,
    lastSyncedAt: new Date(),
    deletedInCrmAt: null,
    isMock,
  };
}

const COMPARE_KEYS = ["fullName", "emailNormalized", "phoneE164", "crmStatus", "crmOwner", "city", "crmEmailOptOut", "secondaryEmail"] as const;

export async function runCrmSync(opts: { actor?: AuditActor | null; type?: SyncType; full?: boolean } = {}) {
  const running = await prisma.syncRun.findFirst({
    where: { provider: "ZOHO_CRM", status: "RUNNING", startedAt: { gt: new Date(Date.now() - 30 * 60_000) } },
  });
  if (running) throw conflict("A CRM sync is already running.");

  const lastOk = await prisma.syncRun.findFirst({
    where: { provider: "ZOHO_CRM", status: { in: ["SUCCEEDED", "PARTIAL"] }, type: { in: ["INITIAL", "INCREMENTAL", "MANUAL"] } },
    orderBy: { startedAt: "desc" },
  });
  const initial = opts.full || !lastOk;
  const watermarkRow = initial ? null : await prisma.client.aggregate({ _max: { crmModifiedAt: true }, where: { isMock: false } });
  const { provider, mode } = await getCrmProvider();
  const isMock = provider.kind === "mock";
  const since = initial ? null : isMock ? lastOk?.finishedAt ?? null : watermarkRow?._max.crmModifiedAt ?? null;

  const run = await prisma.syncRun.create({
    data: {
      provider: "ZOHO_CRM",
      type: opts.type ?? (initial ? "INITIAL" : "INCREMENTAL"),
      triggeredById: opts.actor?.id,
      cursor: since?.toISOString() ?? null,
      stats: { mode },
    },
  });
  const stats: SyncStats = { fetched: 0, created: 0, updated: 0, unchanged: 0, deleted: 0, invalidPhones: 0, missingEmail: 0, duplicatesFlagged: 0, pages: 0 };
  let apiCalls = 0;
  try {
    let pageToken: string | null = null;
    do {
      const page = await provider.fetchContacts({ modifiedSince: since, pageToken });
      apiCalls += 1;
      stats.pages += 1;
      stats.fetched += page.records.length;
      const existing = await prisma.client.findMany({ where: { zohoCrmId: { in: page.records.map((r) => r.id) } } });
      const byCrmId = new Map(existing.map((c) => [c.zohoCrmId, c]));
      for (const rec of page.records) {
        const data = contactToClientData(rec, isMock);
        if (!data.phoneValid && data.phoneRaw) stats.invalidPhones += 1;
        if (!data.emailNormalized) stats.missingEmail += 1;
        const prev = byCrmId.get(rec.id);
        if (!prev) {
          await prisma.client.create({ data: { zohoCrmId: rec.id, ...data } });
          stats.created += 1;
        } else {
          const changed = COMPARE_KEYS.some((k) => (prev as Record<string, unknown>)[k] !== (data as Record<string, unknown>)[k]) || prev.deletedInCrmAt !== null;
          // Only CRM-owned columns are written. client_categories is never touched here.
          await prisma.client.update({ where: { id: prev.id }, data });
          if (changed) stats.updated += 1;
          else stats.unchanged += 1;
        }
      }
      await prisma.syncRun.update({ where: { id: run.id }, data: { stats: { mode, ...stats } as unknown as Prisma.InputJsonValue, apiCalls } });
      pageToken = page.moreRecords ? page.nextPageToken : null;
    } while (pageToken);

    if (!initial) {
      for (let p = 1; p < 500; p++) {
        const del = await provider.fetchDeleted({ since, page: p });
        apiCalls += 1;
        if (del.deleted.length) {
          const r = await prisma.client.updateMany({
            where: { zohoCrmId: { in: del.deleted.map((d) => d.id) }, deletedInCrmAt: null },
            data: { deletedInCrmAt: new Date() },
          });
          stats.deleted += r.count;
        }
        if (!del.moreRecords) break;
      }
    }

    stats.duplicatesFlagged = await resolveDuplicateIdentities();
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: "SUCCEEDED", finishedAt: new Date(), stats: { mode, ...stats } as unknown as Prisma.InputJsonValue, apiCalls },
    });
    await prisma.integrationSetting.update({ where: { provider: "ZOHO_CRM" }, data: { lastSyncAt: new Date() } });
    await audit({ actor: opts.actor, action: "crm.sync_completed", entityType: "sync_run", entityId: run.id, metadata: { ...stats, mode } });
    await evaluateAllRules({ actor: opts.actor ?? null }).catch((e) => console.error("[rules] evaluation after sync failed", e.message));
    return { runId: run.id, stats };
  } catch (err) {
    const message = (err as Error).message;
    await prisma.syncRun.update({
      where: { id: run.id },
      data: { status: stats.fetched > 0 ? "PARTIAL" : "FAILED", finishedAt: new Date(), errorMessage: message.slice(0, 1000), stats: { mode, ...stats } as unknown as Prisma.InputJsonValue, apiCalls },
    });
    await audit({ actor: opts.actor, action: "crm.sync_failed", entityType: "sync_run", entityId: run.id, metadata: { message } });
    throw err;
  }
}

/**
 * Exact normalized-email matches between distinct CRM records are flagged as duplicates of the
 * oldest record. Phone-only matches are surfaced as "possible duplicates" in the UI and are
 * de-duplicated per campaign by the eligibility engine, but not auto-flagged.
 */
export async function resolveDuplicateIdentities(): Promise<number> {
  const groups = await prisma.$queryRaw<{ email: string; ids: string[] }[]>`
    SELECT email_normalized AS email, array_agg(id ORDER BY created_at ASC, zoho_crm_id ASC) AS ids
    FROM clients
    WHERE email_normalized IS NOT NULL AND deleted_in_crm_at IS NULL
    GROUP BY email_normalized
    HAVING COUNT(*) > 1`;
  let flagged = 0;
  const keep = new Set<string>();
  for (const g of groups) {
    const [primary, ...dups] = g.ids;
    keep.add(primary);
    await prisma.client.update({ where: { id: primary }, data: { duplicateOfId: null } });
    // Note: `{ not: x }` excludes NULLs in SQL, so unflagged rows need an explicit OR.
    const r = await prisma.client.updateMany({
      where: { id: { in: dups }, OR: [{ duplicateOfId: null }, { duplicateOfId: { not: primary } }] },
      data: { duplicateOfId: primary },
    });
    flagged += r.count;
  }
  // Clear stale flags where the email no longer collides.
  const stale = await prisma.client.findMany({ where: { duplicateOfId: { not: null } }, select: { id: true, emailNormalized: true, duplicateOf: { select: { emailNormalized: true } } } });
  const clear = stale.filter((s) => !s.emailNormalized || s.emailNormalized !== s.duplicateOf?.emailNormalized).map((s) => s.id);
  if (clear.length) await prisma.client.updateMany({ where: { id: { in: clear } }, data: { duplicateOfId: null } });
  return flagged;
}
