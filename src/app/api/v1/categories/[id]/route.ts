import { apiRoute } from "@/lib/api/handler";
import { CategoryUpdateSchema } from "@/lib/contracts";
import { getCategoryDetail, updateCategory } from "@/lib/services/categories";
import { notFound } from "@/lib/errors";

export const GET = apiRoute<undefined, undefined, { id: string }>({ permission: "categories:read" }, async ({ params }) => {
  const c = await getCategoryDetail(params.id);
  if (!c) throw notFound("Category");
  return c;
});
export const PATCH = apiRoute<typeof CategoryUpdateSchema, undefined, { id: string }>(
  { permission: "categories:write", body: CategoryUpdateSchema },
  async ({ params, body, user }) => updateCategory(params.id, body, user),
);
