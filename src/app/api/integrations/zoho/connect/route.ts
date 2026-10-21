import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { requireApiUser } from "@/lib/auth/guard";
import { errorResponse } from "@/lib/api/handler";
import { randomToken } from "@/lib/crypto";
import { buildAuthorizeUrl } from "@/lib/providers/zoho/oauth";
import { loadIntegration } from "@/lib/services/integrations";
import { badRequest } from "@/lib/errors";

/** Starts the Zoho OAuth flow (server-side). State is bound to an httpOnly cookie. */
export async function GET(req: NextRequest) {
  try {
    await requireApiUser("integrations:write");
    const provider = req.nextUrl.searchParams.get("provider") === "ZOHO_MA" ? "ZOHO_MA" : "ZOHO_CRM";
    const { secrets, config } = await loadIntegration(provider);
    if (!secrets.clientId || !secrets.clientSecret) throw badRequest("Enter the Zoho client ID and secret first.");
    const nonce = randomToken(16);
    (await cookies()).set("ncc_zoho_oauth", `${provider}.${nonce}`, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/api/integrations/zoho", maxAge: 600 });
    return NextResponse.redirect(buildAuthorizeUrl(provider, config.dc, secrets.clientId, `${provider}.${nonce}`));
  } catch (err) {
    return errorResponse(err);
  }
}
