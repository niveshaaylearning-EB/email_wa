import { apiRoute } from "@/lib/api/handler";
import { z } from "zod";
import { getCrmProvider, getEmailProvider, getWhatsAppProvider } from "@/lib/providers/registry";
import { ZohoCrmAdapter } from "@/lib/providers/zoho/crm";
import { ZohoMarketingAutomationAdapter } from "@/lib/providers/zoho/marketing-automation";
import { DoubleTickAdapter } from "@/lib/providers/doubletick/client";
import { audit } from "@/lib/audit";

const Q = z.object({ real: z.enum(["1"]).optional() });
/** Connection tests never send messages. `real=1` tests the real adapter even while in MOCK mode. */
export const POST = apiRoute<undefined, typeof Q, { provider: string }>(
  { permission: "integrations:write", query: Q, rateLimitPerMinute: 10 },
  async ({ params, query, user }) => {
    const provider = z.enum(["ZOHO_CRM", "ZOHO_MA", "DOUBLETICK"]).parse(params.provider);
    const real = query.real === "1";
    const adapter =
      provider === "ZOHO_CRM"
        ? real ? new ZohoCrmAdapter() : (await getCrmProvider()).provider
        : provider === "ZOHO_MA"
          ? real ? new ZohoMarketingAutomationAdapter() : (await getEmailProvider()).provider
          : real ? new DoubleTickAdapter() : (await getWhatsAppProvider()).provider;
    const result = await adapter.testConnection();
    await audit({ actor: user, action: "integration.tested", entityType: "integration", entityId: provider, metadata: { ok: result.ok, message: result.message, real: adapter.kind === "real" } });
    return { ...result, adapter: adapter.kind };
  },
);
