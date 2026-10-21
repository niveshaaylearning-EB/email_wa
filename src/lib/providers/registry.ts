import "server-only";
import type { ProviderMode } from "@prisma/client";
import { ensureIntegration } from "@/lib/services/integrations";
import { ZohoCrmAdapter } from "./zoho/crm";
import { ZohoMarketingAutomationAdapter } from "./zoho/marketing-automation";
import { DoubleTickAdapter } from "./doubletick/client";
import { MockCrmAdapter, MockEmailAdapter, MockWhatsAppAdapter } from "./mock";
import type { CrmProvider, EmailCampaignProvider, WhatsAppProvider } from "./types";

// Test hook: allow injecting adapters.
const overrides: { crm?: CrmProvider; email?: EmailCampaignProvider; whatsapp?: WhatsAppProvider } = {};
export function overrideProviders(o: typeof overrides) {
  Object.assign(overrides, o);
}
export function clearProviderOverrides() {
  delete overrides.crm;
  delete overrides.email;
  delete overrides.whatsapp;
}

const mockEmail = new MockEmailAdapter();
const mockWa = new MockWhatsAppAdapter();
const mockCrm = new MockCrmAdapter();

/**
 * CRM: MOCK → simulated contacts; DRY_RUN/LIVE → real Zoho CRM (read-only API, safe in dry-run).
 */
export async function getCrmProvider(): Promise<{ provider: CrmProvider; mode: ProviderMode }> {
  const row = await ensureIntegration("ZOHO_CRM");
  if (overrides.crm) return { provider: overrides.crm, mode: row.mode };
  return { provider: row.mode === "MOCK" ? mockCrm : new ZohoCrmAdapter(), mode: row.mode };
}

/**
 * Sending providers: MOCK → simulated; DRY_RUN → real adapter available for connection tests,
 * but the orchestrator never calls send paths (and the real adapter re-checks LIVE itself).
 */
export async function getEmailProvider(): Promise<{ provider: EmailCampaignProvider; mode: ProviderMode }> {
  const row = await ensureIntegration("ZOHO_MA");
  if (overrides.email) return { provider: overrides.email, mode: row.mode };
  return { provider: row.mode === "MOCK" ? mockEmail : new ZohoMarketingAutomationAdapter(), mode: row.mode };
}

export async function getWhatsAppProvider(): Promise<{ provider: WhatsAppProvider; mode: ProviderMode }> {
  const row = await ensureIntegration("DOUBLETICK");
  if (overrides.whatsapp) return { provider: overrides.whatsapp, mode: row.mode };
  return { provider: row.mode === "MOCK" ? mockWa : new DoubleTickAdapter(), mode: row.mode };
}
