import { apiRoute } from "@/lib/api/handler";
import { ConnectionInputSchema, listConnections, saveConnection, connectionView } from "@/lib/services/salesforce/connections";

/** Salesforce connections (browser-safe view: masked secret hints only). */
export const GET = apiRoute({ permission: "archive:read" }, async () => listConnections());

export const POST = apiRoute({ permission: "archive:manage", body: ConnectionInputSchema, rateLimitPerMinute: 20 }, async ({ body, user }) => connectionView(await saveConnection(null, body, user)));
