import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { setScheduleEnabled } from "@/lib/services/salesforce/backups";

const Body = z.object({ enabled: z.boolean() });

export const PATCH = apiRoute<typeof Body, undefined, { id: string }>({ permission: "archive:manage", body: Body }, async ({ body, params, user }) => {
  await setScheduleEnabled(params.id, body.enabled, user);
  return { ok: true };
});
