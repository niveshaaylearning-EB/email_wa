import { apiRoute } from "@/lib/api/handler";
import { archiveTemplate } from "@/lib/services/templates";

export const POST = apiRoute<undefined, undefined, { id: string }>({ permission: "templates:write" }, async ({ params, user }) => archiveTemplate(params.id, user));
