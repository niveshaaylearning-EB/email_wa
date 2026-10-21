import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { queueDriver } from "@/lib/queue";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok", db: "ok", queue: queueDriver(), liveSend: process.env.ALLOW_LIVE_SEND === "true" });
  } catch {
    return NextResponse.json({ status: "degraded", db: "error" }, { status: 503 });
  }
}
