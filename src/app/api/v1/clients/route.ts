import { apiRoute } from "@/lib/api/handler";
import { ClientListQuerySchema } from "@/lib/contracts";
import { listClients } from "@/lib/services/clients";

export const GET = apiRoute({ permission: "clients:read", query: ClientListQuerySchema }, async ({ query }) => listClients(query));
