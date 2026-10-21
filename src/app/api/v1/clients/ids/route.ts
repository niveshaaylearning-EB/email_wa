import { apiRoute } from "@/lib/api/handler";
import { ClientListQuerySchema } from "@/lib/contracts";
import { prisma } from "@/lib/db";
import { buildClientWhere } from "@/lib/services/clients";

/** IDs of all clients matching the current filters (for "select all N matching" bulk actions). */
export const GET = apiRoute({ permission: "clients:read", query: ClientListQuerySchema }, async ({ query }) => {
  const rows = await prisma.client.findMany({ where: buildClientWhere(query), select: { id: true }, take: 10_000 });
  return rows.map((r) => r.id);
});
