import { apiRoute } from "@/lib/api/handler";
import { z } from "zod";
import { revokeZoho } from "@/lib/providers/zoho/oauth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export const POST = apiRoute<undefined, undefined, { provider: string }>({ permission: "integrations:write" }, async ({ params, user }) => {
  const provider = z.enum(["ZOHO_CRM", "ZOHO_MA"]).parse(params.provider);
  await revokeZoho(provider);
  await prisma.integrationSetting.update({ where: { provider }, data: { status: "DISCONNECTED", mode: "MOCK" } });
  await audit({ actor: user, action: "integration.disconnected", entityType: "integration", entityId: provider });
  return { ok: true };
});
