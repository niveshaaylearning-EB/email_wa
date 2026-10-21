import { apiRoute } from "@/lib/api/handler";
import { archiveCategory } from "@/lib/services/categories";

export const POST = apiRoute<undefined, undefined, { id: string }>({ permission: "categories:write" }, async ({ params, user }) => archiveCategory(params.id, user));
