import { apiRoute } from "@/lib/api/handler";
import { ScheduleSchema, createSchedule } from "@/lib/services/salesforce/backups";
import { listSchedules } from "@/lib/services/salesforce/queries";

export const GET = apiRoute({ permission: "archive:read" }, async () => listSchedules());

/** Recurring INCREMENTAL backups while Salesforce remains accessible. */
export const POST = apiRoute({ permission: "archive:manage", body: ScheduleSchema, rateLimitPerMinute: 10 }, async ({ body, user }) => createSchedule(body, user));
