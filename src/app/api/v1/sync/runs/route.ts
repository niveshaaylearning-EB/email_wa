import { apiRoute } from "@/lib/api/handler";
import { prisma } from "@/lib/db";

export const GET = apiRoute({ permission: "integrations:read" }, async () => prisma.syncRun.findMany({ orderBy: { startedAt: "desc" }, take: 50 }));
