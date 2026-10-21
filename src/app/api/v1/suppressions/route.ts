import { apiRoute } from "@/lib/api/handler";
import { z } from "zod";
import { SuppressionCreateSchema } from "@/lib/contracts";
import { addSuppression } from "@/lib/services/clients";
import { prisma } from "@/lib/db";

export const GET = apiRoute({ permission: "clients:read", query: z.object({ q: z.string().optional() }) }, async ({ query }) =>
  prisma.suppressionEntry.findMany({
    where: { liftedAt: null, ...(query.q ? { identifierValue: { contains: query.q.toLowerCase() } } : {}) },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { client: { select: { id: true, fullName: true } } },
  }),
);
export const POST = apiRoute({ permission: "suppression:write", body: SuppressionCreateSchema }, async ({ body, user }) => addSuppression(body, user));
