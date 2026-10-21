import { apiRoute } from "@/lib/api/handler";
import { z } from "zod";
import { unmapTemplate } from "@/lib/services/templates";

const Body = z.object({ categoryId: z.string(), templateId: z.string() });
export const POST = apiRoute({ permission: "templates:write", body: Body }, async ({ body, user }) => unmapTemplate(body, user));
