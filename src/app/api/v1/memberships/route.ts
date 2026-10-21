import { apiRoute } from "@/lib/api/handler";
import { MembershipChangeSchema } from "@/lib/contracts";
import { addMembers } from "@/lib/services/categories";

export const POST = apiRoute({ permission: "clients:write", body: MembershipChangeSchema }, async ({ body, user }) =>
  addMembers({ clientIds: body.clientIds, categoryIds: body.categoryIds, source: body.clientIds.length > 1 ? "BULK" : "MANUAL", note: body.note }, user),
);
