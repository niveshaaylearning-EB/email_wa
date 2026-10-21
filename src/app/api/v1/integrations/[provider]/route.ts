import { apiRoute } from "@/lib/api/handler";
import { z } from "zod";
import { DoubleTickConfigSchema, ZohoCrmConfigSchema, ZohoMaConfigSchema, saveSecrets, setMode, updateConfig } from "@/lib/services/integrations";
import { badRequest } from "@/lib/errors";
import type { Provider } from "@prisma/client";

const Providers = z.enum(["ZOHO_CRM", "ZOHO_MA", "DOUBLETICK"]);
const Body = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: z.record(z.string(), z.string().max(4000)).optional(),
  mode: z.enum(["MOCK", "DRY_RUN", "LIVE"]).optional(),
});
const ALLOWED_SECRETS: Record<Provider, string[]> = { ZOHO_CRM: ["clientId", "clientSecret"], ZOHO_MA: ["clientId", "clientSecret"], DOUBLETICK: ["apiKey", "webhookSecret"] };

export const PATCH = apiRoute<typeof Body, undefined, { provider: string }>({ permission: "integrations:write", body: Body, rateLimitPerMinute: 20 }, async ({ params, body, user }) => {
  const provider = Providers.parse(params.provider);
  if (body.secrets) {
    const bad = Object.keys(body.secrets).filter((k) => !ALLOWED_SECRETS[provider].includes(k));
    if (bad.length) throw badRequest(`Unknown secret field(s): ${bad.join(", ")}`);
    await saveSecrets(provider, body.secrets, user);
  }
  if (body.config) {
    const schema = provider === "ZOHO_CRM" ? ZohoCrmConfigSchema : provider === "ZOHO_MA" ? ZohoMaConfigSchema : DoubleTickConfigSchema;
    const patch = schema.partial().parse(body.config);
    await updateConfig(provider, patch as never, user);
  }
  if (body.mode) await setMode(provider, body.mode, user);
  return { ok: true };
});
