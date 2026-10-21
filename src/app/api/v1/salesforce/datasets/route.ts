import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { verificationBoard } from "@/lib/services/salesforce/queries";

const Q = z.object({ status: z.string().optional(), kind: z.string().optional(), page: z.coerce.number().int().min(1).default(1) });

/** Dataset inventory with verification status (current, non-superseded datasets). */
export const GET = apiRoute({ permission: "archive:read", query: Q }, async ({ query }) =>
  (await verificationBoard(query, query.page)).rows.map((d) => ({
    id: d.id,
    kind: d.kind,
    label: d.label,
    mid: d.mid,
    sourceKey: d.sourceKey,
    status: d.status,
    verificationStatus: d.verificationStatus,
    recordsExtracted: d.recordsExtracted,
    sourceCount: d.sourceCount,
    pagesFetched: d.pagesFetched,
    finishedAt: d.finishedAt,
    sealedAt: d.sealedAt,
    backupJob: d.backupJob?.code ?? null,
    checks: d.checks,
  })),
);
