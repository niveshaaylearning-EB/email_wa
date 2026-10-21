import { apiRoute } from "@/lib/api/handler";
import { z } from "zod";
import { importMembershipCsv } from "@/lib/services/categories";

const Body = z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(true) });
export const POST = apiRoute<typeof Body, undefined, { id: string }>(
  { permission: "categories:write", body: Body, rateLimitPerMinute: 20 },
  async ({ params, body, user }) => importMembershipCsv({ categoryId: params.id, csv: body.csv, dryRun: body.dryRun }, user),
);
