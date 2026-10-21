import { apiRoute } from "@/lib/api/handler";
import { z } from "zod";
import { CategoryCreateSchema } from "@/lib/contracts";
import { createCategory, listCategories } from "@/lib/services/categories";

export const GET = apiRoute(
  { permission: "categories:read", query: z.object({ q: z.string().optional(), archived: z.enum(["1"]).optional() }) },
  async ({ query }) => listCategories({ q: query.q, includeArchived: !!query.archived }),
);
export const POST = apiRoute({ permission: "categories:write", body: CategoryCreateSchema }, async ({ body, user }) => createCategory(body, user));
