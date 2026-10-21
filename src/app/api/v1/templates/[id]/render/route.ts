import { apiRoute } from "@/lib/api/handler";
import { TemplateRenderTestSchema } from "@/lib/contracts";
import { testRender } from "@/lib/services/templates";

export const POST = apiRoute<typeof TemplateRenderTestSchema, undefined, { id: string }>(
  { permission: "templates:read", body: TemplateRenderTestSchema },
  async ({ params, body }) => testRender(params.id, { clientId: body.clientId }),
);
