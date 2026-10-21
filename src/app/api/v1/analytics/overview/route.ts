import { apiRoute } from "@/lib/api/handler";
import { z } from "zod";
import { getOverview, getTrends, getCategoryPerformance } from "@/lib/services/analytics";

export const GET = apiRoute({ permission: "analytics:read", query: z.object({ days: z.coerce.number().int().min(1).max(730).default(30) }) }, async ({ query }) => {
  const range = { from: new Date(Date.now() - query.days * 86400_000), to: new Date() };
  const [overview, daily, categories] = await Promise.all([getOverview(range), getTrends(range, "day"), getCategoryPerformance(range)]);
  return { overview, daily, categories };
});
