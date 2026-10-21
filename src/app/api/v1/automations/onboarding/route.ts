// TEST MODULE — DoubleTick onboarding bot trigger. Remove after testing (docs/doubletick-onboarding-test.md).
import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { onboardingConfig, recentOnboardingRuns, triggerOnboarding } from "@/lib/services/onboarding-trigger";

const Body = z
  .object({
    testRecipientId: z.string().max(64).optional(),
    clientId: z.string().max(64).optional(),
    dryRun: z.boolean().default(true),
    confirm: z.string().max(10).optional(),
  })
  .refine((b) => !!b.testRecipientId !== !!b.clientId, "Choose exactly one test recipient or client");

export const GET = apiRoute({ permission: "integrations:write" }, async () => {
  const cfg = onboardingConfig();
  return { config: { ...cfg, url: undefined }, runs: await recentOnboardingRuns() };
});

export const POST = apiRoute({ permission: "integrations:write", body: Body, rateLimitPerMinute: 10 }, async ({ body, user }) => triggerOnboarding(body, user));
