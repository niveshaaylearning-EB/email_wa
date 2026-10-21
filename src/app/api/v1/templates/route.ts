import { apiRoute } from "@/lib/api/handler";
import { z } from "zod";
import { TemplateUpsertSchema } from "@/lib/contracts";
import { createTemplate, listTemplates } from "@/lib/services/templates";

export const GET = apiRoute(
  { permission: "templates:read", query: z.object({ channel: z.enum(["EMAIL", "WHATSAPP"]).optional(), categoryId: z.string().optional(), q: z.string().optional() }) },
  async ({ query }) => listTemplates(query),
);
export const POST = apiRoute({ permission: "templates:write", body: TemplateUpsertSchema }, async ({ body, user }) => createTemplate(body, user));
