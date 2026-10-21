import { apiRoute } from "@/lib/api/handler";
import { ConnectionInputSchema, archiveConnection, connectionView, saveConnection } from "@/lib/services/salesforce/connections";

export const PATCH = apiRoute<typeof ConnectionInputSchema, undefined, { id: string }>({ permission: "archive:manage", body: ConnectionInputSchema, rateLimitPerMinute: 20 }, async ({ body, params, user }) =>
  connectionView(await saveConnection(params.id, body, user)),
);

/** Erases stored credentials and hides the connection. Archived data is retained. */
export const DELETE = apiRoute<undefined, undefined, { id: string }>({ permission: "archive:manage", rateLimitPerMinute: 10 }, async ({ params, user }) => {
  await archiveConnection(params.id, user);
  return { ok: true };
});
