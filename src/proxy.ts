import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic auth gate for pages only: redirects to /login when no session cookie is present.
 * Real authorisation (session validity + role permissions) is enforced on the server in every
 * page (requirePageUser) and every API route (apiRoute) — never rely on this alone.
 */
export function proxy(req: NextRequest) {
  const hasSession = req.cookies.has("ncc_session");
  const { pathname } = req.nextUrl;
  if (!hasSession && pathname !== "/login") {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
