import { apiRoute } from "@/lib/api/handler";
import { listIntegrationsForUi } from "@/lib/services/integrations";

export const GET = apiRoute({ permission: "integrations:read" }, async () => listIntegrationsForUi());
