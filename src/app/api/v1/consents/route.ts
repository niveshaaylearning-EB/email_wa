import { apiRoute } from "@/lib/api/handler";
import { ConsentRecordSchema } from "@/lib/contracts";
import { recordConsent } from "@/lib/services/clients";

export const POST = apiRoute({ permission: "clients:write", body: ConsentRecordSchema }, async ({ body, user }) => recordConsent(body, user));
