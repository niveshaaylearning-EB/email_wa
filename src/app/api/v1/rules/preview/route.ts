import { apiRoute } from "@/lib/api/handler";
import { z } from "zod";
import { RuleDefinitionSchema } from "@/lib/domain/rules";
import { previewRule } from "@/lib/services/rules";

const Body = z.object({ definition: RuleDefinitionSchema });
export const POST = apiRoute({ permission: "categories:read", body: Body }, async ({ body }) => previewRule(body.definition));
