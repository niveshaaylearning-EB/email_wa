import { apiRoute } from "@/lib/api/handler";
import { testSend } from "@/lib/services/campaigns";
import { TestSendSchema } from "@/lib/contracts";

export const POST = apiRoute<typeof TestSendSchema, undefined, { id: string }>(
  { permission: "campaigns:write", body: TestSendSchema, rateLimitPerMinute: 30 },
  async ({ params, body, user }) => testSend(params.id, body, user),
);
