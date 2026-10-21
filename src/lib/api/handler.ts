import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type z } from "zod";
import { Prisma } from "@prisma/client";
import { AppError, forbidden, tooManyRequests } from "@/lib/errors";
import { requireApiUser } from "@/lib/auth/guard";
import type { Permission } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { TransitionError } from "@/lib/domain/campaign-state";
import { maskDeep } from "@/lib/mask";

export const CSRF_HEADER = "x-ncc-request";

export interface ApiContext<TBody, TQuery, TParams> {
  req: NextRequest;
  user: SessionUser;
  body: TBody;
  query: TQuery;
  params: TParams;
  meta: { ip?: string; userAgent?: string };
}

interface RouteOptions<B extends z.ZodType | undefined, Q extends z.ZodType | undefined> {
  permission?: Permission;
  body?: B;
  query?: Q;
  /** requests per minute per user+route; default 120 for mutations, 600 for reads */
  rateLimitPerMinute?: number;
}

type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined;

export function errorResponse(err: unknown): NextResponse {
  if (err instanceof AppError) {
    return NextResponse.json({ error: { code: err.code, message: err.message, details: err.details } }, { status: err.status });
  }
  if (err instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Some fields are invalid. Please review and try again.",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
      { status: 422 },
    );
  }
  if (err instanceof TransitionError) {
    return NextResponse.json({ error: { code: "INVALID_STATE", message: err.message } }, { status: 409 });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return NextResponse.json({ error: { code: "CONFLICT", message: "A record with these details already exists." } }, { status: 409 });
    }
    if (err.code === "P2025") {
      return NextResponse.json({ error: { code: "NOT_FOUND", message: "Record not found." } }, { status: 404 });
    }
  }
  console.error("[api] unhandled error", maskDeep(err instanceof Error ? { message: err.message, stack: err.stack } : err));
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Something went wrong on our side. The error has been logged." } },
    { status: 500 },
  );
}

function checkCsrf(req: NextRequest) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  // A custom header cannot be set cross-origin without a CORS preflight (which we never allow),
  // and SameSite=Lax cookies are not sent on cross-site POSTs. Origin is checked as a third layer.
  if (req.headers.get(CSRF_HEADER) !== "1") throw forbidden("Missing request verification header.");
  const origin = req.headers.get("origin");
  if (origin) {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (new URL(origin).host !== host) throw forbidden("Cross-origin request rejected.");
  }
}

/**
 * Typed authenticated route handler: auth → permission → CSRF → rate limit → validation → handler.
 */
export function apiRoute<
  B extends z.ZodType | undefined = undefined,
  Q extends z.ZodType | undefined = undefined,
  P extends Record<string, string> = Record<string, string>,
>(
  opts: RouteOptions<B, Q>,
  handler: (ctx: ApiContext<Infer<B>, Infer<Q>, P>) => Promise<unknown>,
) {
  return async (req: NextRequest, routeCtx?: { params: Promise<P> }) => {
    try {
      const user = await requireApiUser(opts.permission);
      checkCsrf(req);
      const isRead = req.method === "GET";
      const limit = opts.rateLimitPerMinute ?? (isRead ? 600 : 120);
      const rl = await rateLimit(`${user.id}:${req.method}:${req.nextUrl.pathname}`, limit, 60_000);
      if (!rl.ok) throw tooManyRequests();

      let body: unknown = undefined;
      if (opts.body) {
        const json = await req.json().catch(() => {
          throw new AppError(400, "BAD_JSON", "Request body must be valid JSON.");
        });
        body = opts.body.parse(json);
      }
      let query: unknown = undefined;
      if (opts.query) query = opts.query.parse(Object.fromEntries(req.nextUrl.searchParams));
      const params = (routeCtx ? await routeCtx.params : {}) as P;
      const meta = {
        ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
        userAgent: req.headers.get("user-agent") ?? undefined,
      };
      const result = await handler({ req, user, body: body as Infer<B>, query: query as Infer<Q>, params, meta });
      if (result instanceof Response) return result;
      return NextResponse.json({ data: result ?? null });
    } catch (err) {
      return errorResponse(err);
    }
  };
}
