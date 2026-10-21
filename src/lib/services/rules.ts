import "server-only";
import { prisma } from "@/lib/db";
import { evaluateRule, RuleDefinitionSchema, type RuleDefinition } from "@/lib/domain/rules";
import { audit, type AuditActor } from "@/lib/audit";

const subjectSelect = {
  id: true,
  crmStatus: true,
  city: true,
  phoneCountry: true,
  crmOwner: true,
  emailNormalized: true,
  phoneValid: true,
  crmFields: true,
} as const;

export async function previewRule(definition: RuleDefinition) {
  const clients = await prisma.client.findMany({ where: { deletedInCrmAt: null }, select: { ...subjectSelect, fullName: true } });
  const matches = clients.filter((c) => evaluateRule({ ...c, crmFields: (c.crmFields ?? {}) as Record<string, unknown> }, definition));
  return { count: matches.length, sample: matches.slice(0, 10).map((m) => ({ id: m.id, fullName: m.fullName })) };
}

/**
 * Re-evaluates one rule. Adds RULE memberships for new matches; when `autoRemove` is on,
 * removes RULE memberships created by this rule that no longer match. Manual/bulk/CSV
 * memberships are never altered, and a client already a member through another source is left as is.
 */
export async function evaluateRuleById(ruleId: string, actor: AuditActor | null) {
  const rule = await prisma.categoryRule.findUniqueOrThrow({ where: { id: ruleId }, include: { category: true } });
  if (!rule.isActive || rule.archivedAt || rule.category.archivedAt) return { added: 0, removed: 0, matched: 0 };
  const def = RuleDefinitionSchema.parse(rule.definition);
  const clients = await prisma.client.findMany({ where: { deletedInCrmAt: null }, select: subjectSelect });
  const matchedIds = new Set(
    clients.filter((c) => evaluateRule({ ...c, crmFields: (c.crmFields ?? {}) as Record<string, unknown> }, def)).map((c) => c.id),
  );
  const memberships = await prisma.clientCategory.findMany({ where: { categoryId: rule.categoryId } });
  const byClient = new Map(memberships.map((m) => [m.clientId, m]));
  let added = 0;
  let removed = 0;
  await prisma.$transaction(async (tx) => {
    for (const clientId of matchedIds) {
      const m = byClient.get(clientId);
      if (m && !m.removedAt) continue;
      if (m && m.removedAt && m.source !== "RULE") continue; // a human removed them deliberately — respect it
      await tx.clientCategory.upsert({
        where: { clientId_categoryId: { clientId, categoryId: rule.categoryId } },
        create: { clientId, categoryId: rule.categoryId, source: "RULE", ruleId: rule.id },
        update: { removedAt: null, removedById: null, source: "RULE", ruleId: rule.id, addedAt: new Date() },
      });
      await tx.membershipEvent.create({
        data: { clientId, categoryId: rule.categoryId, action: "ADDED", source: "RULE", actorId: actor?.id, note: `Rule: ${rule.name}` },
      });
      added += 1;
    }
    if (rule.autoRemove) {
      for (const m of memberships) {
        if (m.removedAt || m.source !== "RULE" || m.ruleId !== rule.id || matchedIds.has(m.clientId)) continue;
        await tx.clientCategory.update({ where: { id: m.id }, data: { removedAt: new Date(), removedById: actor?.id } });
        await tx.membershipEvent.create({
          data: { clientId: m.clientId, categoryId: rule.categoryId, action: "REMOVED", source: "RULE", actorId: actor?.id, note: `Rule no longer matches: ${rule.name}` },
        });
        removed += 1;
      }
    }
    await tx.categoryRule.update({ where: { id: rule.id }, data: { lastEvaluatedAt: new Date(), lastMatchCount: matchedIds.size } });
  });
  await audit({ actor, action: "category.rule_evaluated", entityType: "category_rule", entityId: rule.id, metadata: { categoryId: rule.categoryId, matched: matchedIds.size, added, removed } });
  return { added, removed, matched: matchedIds.size };
}

export async function evaluateAllRules({ actor }: { actor: AuditActor | null }) {
  const rules = await prisma.categoryRule.findMany({ where: { isActive: true, archivedAt: null, category: { archivedAt: null } }, select: { id: true } });
  const results = [];
  for (const r of rules) results.push({ ruleId: r.id, ...(await evaluateRuleById(r.id, actor)) });
  return results;
}
