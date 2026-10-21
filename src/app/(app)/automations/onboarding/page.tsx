// TEST MODULE — DoubleTick onboarding bot trigger. Remove after testing (docs/doubletick-onboarding-test.md).
import { FlaskConicalIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/app/page-header";
import { Notice } from "@/components/app/empty-state";
import { onboardingConfig, recentOnboardingRuns } from "@/lib/services/onboarding-trigger";
import { OnboardingTester } from "./onboarding-tester";

export const metadata = { title: "Onboarding bot (test)" };

export default async function OnboardingTestPage() {
  await requirePageUser("integrations:write");
  const [testRecipients, runs] = await Promise.all([
    prisma.internalTestRecipient.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
    recentOnboardingRuns(),
  ]);
  const cfg = onboardingConfig();
  return (
    <div className="animate-in-fade space-y-5">
      <PageHeader
        title="Onboarding bot (test)"
        description="Triggers DoubleTick's onboarding_entity_type bot, which sends the welcome WhatsApp message with entity-type options. Temporary test module — removed once the flow moves to the live dashboard."
      />
      <Notice tone="warning" icon={FlaskConicalIcon} title="Every real call sends a real WhatsApp message">
        Use only internal test numbers you control (Settings → Test recipients). Real clients are blocked here. Preview builds the exact request without calling DoubleTick.
      </Notice>
      <OnboardingTester
        config={{ urlValid: cfg.urlValid, triggerId: cfg.triggerId, hasAuthKey: cfg.hasAuthKey, liveSendEnabled: cfg.liveSendEnabled }}
        testRecipients={testRecipients.map((r) => ({ id: r.id, name: r.name, phoneE164: r.phoneE164 }))}
        runs={runs.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString(), actorEmail: r.actorEmail, metadata: r.metadata as Record<string, unknown> }))}
      />
    </div>
  );
}
