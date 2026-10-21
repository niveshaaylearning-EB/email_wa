import { NextResponse, type NextRequest } from "next/server";
import { emailContentForToken } from "@/lib/services/email-content";

/** Public, unguessable URL that Zoho Marketing Automation fetches as campaign `content_url`. */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const html = await emailContentForToken(token);
  if (!html) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
