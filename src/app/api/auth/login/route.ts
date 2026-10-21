import { NextResponse, type NextRequest } from "next/server";
import { LoginSchema } from "@/lib/contracts";
import { authenticate, setSessionCookie } from "@/lib/auth/session";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { errorResponse } from "@/lib/api/handler";
import { tooManyRequests } from "@/lib/errors";

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
    const limit = process.env.NODE_ENV === "production" ? 10 : 500; // relaxed locally for automated tests
    if (!(await rateLimit(`login:${ip}`, limit, 15 * 60_000)).ok) throw tooManyRequests("Too many sign-in attempts. Please wait 15 minutes.");
    const body = LoginSchema.parse(await req.json());
    const meta = { ip, userAgent: req.headers.get("user-agent") ?? undefined };
    const result = await authenticate(body.email, body.password, meta);
    if (!result.ok) {
      await audit({ action: "auth.login_failed", entityType: "user", metadata: { email: body.email }, ...meta });
      return NextResponse.json({ error: { code: "INVALID_CREDENTIALS", message: result.reason } }, { status: 401 });
    }
    await setSessionCookie(result.token, result.expiresAt);
    await audit({ actor: result.user, action: "auth.login", entityType: "user", entityId: result.user.id, ...meta });
    return NextResponse.json({ data: { name: result.user.name, role: result.user.role } });
  } catch (err) {
    return errorResponse(err);
  }
}
