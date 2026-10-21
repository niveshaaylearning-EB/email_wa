import { apiRoute } from "@/lib/api/handler";
import { UserCreateSchema } from "@/lib/contracts";
import { createUser, listUsers } from "@/lib/services/users";

export const GET = apiRoute({ permission: "users:manage" }, async () => listUsers());
export const POST = apiRoute({ permission: "users:manage", body: UserCreateSchema }, async ({ body, user }) => createUser(body, user));
