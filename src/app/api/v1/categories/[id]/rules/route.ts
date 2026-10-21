import { apiRoute } from "@/lib/api/handler";
import { RuleCreateSchema } from "@/lib/contracts";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

export const POST = apiRoute<typeof RuleCreateSchema, undefined, { id: string }>(
  { permission: "categories:write", body: RuleCreateSchema },
  async ({ params, body, user }) => {
    const rule = await prisma.categoryRule.create({
      data: { categoryId: params.id, name: body.name, definition: body.definition as Prisma.InputJsonValue, autoRemove: body.autoRemove, isActive: body.isActive, createdById: user.id },
    });
    await audit({ actor: user, action: "category.rule_created", entityType: "category_rule", entityId: rule.id, metadata: { categoryId: params.id, definition: body.definition } });
    return rule;
  },
);
