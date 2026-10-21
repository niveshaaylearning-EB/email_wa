import { apiRoute } from "@/lib/api/handler";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export const DELETE = apiRoute<undefined, undefined, { id: string }>({ permission: "categories:write" }, async ({ params, user }) => {
  await prisma.categoryRule.update({ where: { id: params.id }, data: { archivedAt: new Date(), isActive: false } });
  await audit({ actor: user, action: "category.rule_archived", entityType: "category_rule", entityId: params.id });
  return { ok: true };
});
