import { apiRoute } from "@/lib/api/handler";
import { UserUpdateSchema } from "@/lib/contracts";
import { updateUser } from "@/lib/services/users";

export const PATCH = apiRoute<typeof UserUpdateSchema, undefined, { id: string }>({ permission: "users:manage", body: UserUpdateSchema }, async ({ params, body, user }) => updateUser(params.id, body, user));
