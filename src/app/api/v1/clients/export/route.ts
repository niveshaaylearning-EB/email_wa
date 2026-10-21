import { NextResponse } from "next/server";
import { apiRoute } from "@/lib/api/handler";
import { ClientListQuerySchema } from "@/lib/contracts";
import { exportClientsCsv } from "@/lib/services/clients";
import { audit } from "@/lib/audit";

export const GET = apiRoute({ permission: "clients:read", query: ClientListQuerySchema, rateLimitPerMinute: 10 }, async ({ query, user }) => {
  const csv = await exportClientsCsv(query);
  await audit({ actor: user, action: "clients.exported", entityType: "client", metadata: { filters: query } });
  return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="clients-${new Date().toISOString().slice(0, 10)}.csv"` } });
});
