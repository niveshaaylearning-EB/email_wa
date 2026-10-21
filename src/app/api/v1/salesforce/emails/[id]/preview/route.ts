import { z } from "zod";
import { apiRoute } from "@/lib/api/handler";
import { prisma } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { getObject } from "@/lib/salesforce/storage";
import { renderArchivedHtml } from "@/lib/services/salesforce/content";

const Q = z.object({ mode: z.enum(["archived", "remote", "source", "text"]).default("archived") });

/** Sanitised, sandboxed preview of an archived email (SOAP Email object). Images come from the archive by default. */
export const GET = apiRoute<undefined, typeof Q, { id: string }>({ permission: "archive:read", query: Q }, async ({ params, query }) => {
  const e = await prisma.salesforceEmail.findUnique({ where: { id: params.id } });
  if (!e) throw notFound("Archived email");
  if (query.mode === "text" || !e.htmlStorageKey) {
    if (!e.textStorageKey) throw notFound("Archived email body");
    return renderArchivedHtml(e.connectionId, (await getObject(e.textStorageKey)).toString("utf8"), "source");
  }
  return renderArchivedHtml(e.connectionId, (await getObject(e.htmlStorageKey)).toString("utf8"), query.mode as "archived" | "remote" | "source");
});
