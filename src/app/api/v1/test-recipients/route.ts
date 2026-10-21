import { apiRoute } from "@/lib/api/handler";
import { TestRecipientSchema } from "@/lib/contracts";
import { addTestRecipient, listTestRecipients } from "@/lib/services/users";

export const GET = apiRoute({ permission: "campaigns:read" }, async () => listTestRecipients());
export const POST = apiRoute({ permission: "settings:write", body: TestRecipientSchema }, async ({ body, user }) => addTestRecipient(body, user));
