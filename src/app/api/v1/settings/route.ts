import { apiRoute } from "@/lib/api/handler";
import { AppSettingsSchema, getAppSettings, updateAppSettings } from "@/lib/services/settings";

const Patch = AppSettingsSchema.partial();
export const GET = apiRoute({ permission: "campaigns:read" }, async () => getAppSettings());
export const PATCH = apiRoute({ permission: "settings:write", body: Patch }, async ({ body, user }) => updateAppSettings(body, user));
