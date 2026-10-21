import { apiRoute } from "@/lib/api/handler";
import { TemplateUpsertSchema } from "@/lib/contracts";
import { getTemplateDetail, updateTemplate } from "@/lib/services/templates";
import { notFound } from "@/lib/errors";

export const GET = apiRoute<undefined, undefined, { id: string }>({ permission: "templates:read" }, async ({ params }) => {
  const t = await getTemplateDetail(params.id);
  if (!t) throw notFound("Template");
  return t;
});
export const PUT = apiRoute<typeof TemplateUpsertSchema, undefined, { id: string }>(
  { permission: "templates:write", body: TemplateUpsertSchema },
  async ({ params, body, user }) => updateTemplate(params.id, body, user),
);
