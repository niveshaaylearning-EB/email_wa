import { apiRoute } from "@/lib/api/handler";
import { restoreCategory } from "@/lib/services/categories";

export const POST = apiRoute<undefined, undefined, { id: string }>({ permission: "categories:write" }, async ({ params, user }) => restoreCategory(params.id, user));
