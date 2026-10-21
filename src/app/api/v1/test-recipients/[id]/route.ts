import { apiRoute } from "@/lib/api/handler";
import { removeTestRecipient } from "@/lib/services/users";

export const DELETE = apiRoute<undefined, undefined, { id: string }>({ permission: "settings:write" }, async ({ params, user }) => removeTestRecipient(params.id, user));
