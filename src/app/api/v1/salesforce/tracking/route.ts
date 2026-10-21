import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { searchTracking, subscriberTimeline } from "@/lib/services/salesforce/queries";
import { archiveAudit } from "@/lib/services/salesforce/audit";

const Q = z.object({
  subscriberKey: z.string().max(254).optional(),
  jobId: z.string().regex(/^\d{1,15}$/).optional(),
  eventType: z.enum(["SENT", "OPEN", "CLICK", "BOUNCE", "UNSUB", "NOTSENT"]).optional(),
  mid: z.string().regex(/^\d{1,12}$/).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  timeline: z.enum(["1"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

/** Recipient-level tracking search; with timeline=1 returns the per-job timeline for one subscriber. */
export const GET = apiRoute({ permission: "archive:read", query: Q }, async ({ query, user, meta }) => {
  if (query.subscriberKey) await archiveAudit({ actor: user, action: "archive.view.subscriber", entityType: "salesforce_subscriber", entityId: query.subscriberKey, metadata: { via: "api" }, ...meta });
  if (query.timeline === "1") {
    if (!query.subscriberKey) return { timeline: [], memberships: [], subscriber: null, eventCount: 0 };
    return subscriberTimeline(query.subscriberKey, query.mid);
  }
  return searchTracking({ ...query, from: query.from ? new Date(query.from) : undefined, to: query.to ? new Date(query.to) : undefined });
});
