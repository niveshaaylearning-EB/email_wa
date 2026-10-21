import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { addManualBusinessUnit, discoverBusinessUnits, setBusinessUnitSelection } from "@/lib/services/salesforce/connections";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("discover") }),
  z.object({ action: z.literal("select"), mids: z.array(z.string().regex(/^\d{1,12}$/)).max(200) }),
  z.object({ action: z.literal("add"), mid: z.string().regex(/^\d{1,12}$/), name: z.string().trim().min(1).max(100) }),
]);

/** Business Unit discovery (SOAP BusinessUnit retrieve, falling back to token identifiers) and selection. */
export const POST = apiRoute<typeof Body, undefined, { id: string }>({ permission: "archive:manage", body: Body, rateLimitPerMinute: 20 }, async ({ body, params, user }) => {
  if (body.action === "discover") return discoverBusinessUnits(params.id, user);
  if (body.action === "select") {
    await setBusinessUnitSelection(params.id, body.mids, user);
    return { ok: true };
  }
  await addManualBusinessUnit(params.id, body.mid, body.name, user);
  return { ok: true };
});
