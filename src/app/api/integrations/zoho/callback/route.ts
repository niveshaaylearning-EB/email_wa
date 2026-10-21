import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { requireApiUser } from "@/lib/auth/guard";
import { exchangeCode } from "@/lib/providers/zoho/oauth";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { safeEqual } from "@/lib/crypto";
import { env } from "@/lib/env";

export async function GET(req: NextRequest) {
  const back = (q: string) => NextResponse.redirect(`${env().APP_URL}/integrations?${q}`);
  try {
    const user = await requireApiUser("integrations:write");
    const jar = await cookies();
    const expected = jar.get("ncc_zoho_oauth")?.value;
    jar.delete("ncc_zoho_oauth");
    const sp = req.nextUrl.searchParams;
    if (sp.get("error")) return back("oauth=denied");
    const state = sp.get("state") ?? "";
    if (!expected || !safeEqual(state, expected)) return back("oauth=state_mismatch");
    const provider = state.startsWith("ZOHO_MA.") ? "ZOHO_MA" : "ZOHO_CRM";
    const code = sp.get("code");
    const accountsServer = sp.get("accounts-server") ?? "";
    if (!code) return back("oauth=missing_code");
    await exchangeCode(provider, code, accountsServer);
    await prisma.integrationSetting.update({ where: { provider }, data: { status: "CONFIGURED", accountInfo: { location: sp.get("location"), accountsServer } } });
    await audit({ actor: user, action: "integration.oauth_connected", entityType: "integration", entityId: provider, metadata: { location: sp.get("location") } });
    return back(`oauth=connected&provider=${provider}`);
  } catch (err) {
    return back(`oauth=error&message=${encodeURIComponent((err as Error).message.slice(0, 200))}`);
  }
}
