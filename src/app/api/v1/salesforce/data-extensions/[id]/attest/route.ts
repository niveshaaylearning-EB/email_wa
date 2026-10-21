import { apiRoute } from "@/lib/api/handler";
import { AttestSchema, attestDataExtensionCount } from "@/lib/services/salesforce/operations";

/** Record the row count shown in the Salesforce UI as an independent verification source. */
export const POST = apiRoute<typeof AttestSchema, undefined, { id: string }>({ permission: "archive:reconcile", body: AttestSchema, rateLimitPerMinute: 20 }, async ({ body, params, user }) => attestDataExtensionCount(params.id, body, user));
