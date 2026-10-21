import { apiRoute } from "@/lib/api/handler";
import { z } from "zod";
import { enqueue, queueDriver } from "@/lib/queue";
import { runCrmSync } from "@/lib/services/crm-sync";
import { audit } from "@/lib/audit";

const Body = z.object({ full: z.boolean().default(false) });
export const POST = apiRoute({ permission: "sync:run", body: Body, rateLimitPerMinute: 4 }, async ({ body, user }) => {
  await audit({ actor: user, action: "crm.sync_requested", entityType: "sync_run", metadata: { full: body.full } });
  if (queueDriver() === "bullmq") {
    await enqueue("crm.sync", { full: body.full }, { jobId: `crm-sync-manual:${Date.now()}` });
    return { queued: true };
  }
  const r = await runCrmSync({ actor: user, type: "MANUAL", full: body.full });
  return { queued: false, ...r };
});
