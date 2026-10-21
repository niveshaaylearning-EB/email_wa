import { apiRoute } from "@/lib/api/handler";
import { submitForApproval } from "@/lib/services/campaigns";

export const POST = apiRoute<undefined, undefined, { id: string }>({ permission: "campaigns:write", rateLimitPerMinute: 30 }, async ({ params, user }) => submitForApproval(params.id, user));
