import { apiRoute } from "@/lib/api/handler";
import { liftSuppression } from "@/lib/services/clients";

export const POST = apiRoute<undefined, undefined, { id: string }>({ permission: "suppression:write" }, async ({ params, user }) => liftSuppression(params.id, user));
