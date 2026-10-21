import { apiRoute } from "@/lib/api/handler";
import { MembershipChangeSchema } from "@/lib/contracts";
import { removeMembers } from "@/lib/services/categories";

export const POST = apiRoute({ permission: "clients:write", body: MembershipChangeSchema }, async ({ body, user }) => removeMembers(body, user));
