import { NextResponse, type NextRequest } from "next/server";
import { handleDoubleTickStatusWebhook } from "@/lib/services/webhooks";
import { rateLimit } from "@/lib/rate-limit";

/**
 * DoubleTick MESSAGE_STATUS_UPDATE receiver. Register with
 *   url: {APP_URL}/api/webhooks/doubletick/status, webhookEvents: ["MESSAGE_STATUS_UPDATE"],
 *   authorization: { type: "BEARER", payload: DOUBLETICK_WEBHOOK_SECRET }
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!(await rateLimit(`wh:dt:${ip}`, 3000, 60_000)).ok) return NextResponse.json({ error: "rate limited" }, { status: 429 });
  const raw = await req.text();
  if (raw.length > 1_000_000) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  try {
    const r = await handleDoubleTickStatusWebhook(raw, req.headers);
    return NextResponse.json(r.body, { status: r.status });
  } catch (err) {
    console.error("[webhook:doubletick] processing error", (err as Error).message);
    return NextResponse.json({ error: "processing error" }, { status: 500 });
  }
}
