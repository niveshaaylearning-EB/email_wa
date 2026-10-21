import { apiRoute } from "@/lib/api/handler";
import { evaluateRuleById } from "@/lib/services/rules";

export const POST = apiRoute<undefined, undefined, { id: string }>(
  { permission: "categories:write", rateLimitPerMinute: 10 },
  async ({ params, user }) => evaluateRuleById(params.id, user),
);
