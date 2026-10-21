import { apiRoute } from "@/lib/api/handler";
import { TemplateMappingSchema } from "@/lib/contracts";
import { mapTemplateToCategory } from "@/lib/services/templates";

export const POST = apiRoute({ permission: "templates:write", body: TemplateMappingSchema }, async ({ body, user }) => mapTemplateToCategory(body, user));
