// TEST MODULE — email + WhatsApp test to Jay Chaudhari. Remove after testing (docs/doubletick-onboarding-test.md).
import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { sendTeamTest, sendTestToJay } from "@/lib/services/test-send-jay";

const Body = z.object({ contentUrl: z.string().url().max(500), confirm: z.string().max(10).optional(), channels: z.array(z.enum(["EMAIL", "WHATSAPP"])).max(2).optional() });

export const POST = apiRoute({ permission: "integrations:write", body: Body, rateLimitPerMinute: 3 }, async ({ body, user }) => sendTestToJay(body, user));

const TeamBody = z.object({
  contentUrl: z.string().url().max(500),
  confirm: z.string().max(10).optional(),
  emails: z.array(z.string().email()).max(10),
  testRecipientIds: z.array(z.string().max(64)).max(15),
});
/** Team test (PUT): approved addresses + approved test recipients only (hard locks apply). */
export const PUT = apiRoute({ permission: "integrations:write", body: TeamBody, rateLimitPerMinute: 2 }, async ({ body, user }) => sendTeamTest(body, user));
