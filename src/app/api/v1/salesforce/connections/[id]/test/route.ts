import { apiRoute } from "@/lib/api/handler";
import { testConnection } from "@/lib/services/salesforce/connections";

/** Authenticates and runs one read probe per capability. Never writes to Salesforce. */
export const POST = apiRoute<undefined, undefined, { id: string }>({ permission: "archive:manage", rateLimitPerMinute: 10 }, async ({ params, user }) => testConnection(params.id, user));
