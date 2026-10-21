import { apiRoute } from "@/lib/api/handler";
import { getClientProfile } from "@/lib/services/clients";
import { notFound } from "@/lib/errors";

export const GET = apiRoute<undefined, undefined, { id: string }>({ permission: "clients:read" }, async ({ params }) => {
  const c = await getClientProfile(params.id);
  if (!c) throw notFound("Client");
  return c;
});
