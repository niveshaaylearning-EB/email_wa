import { NextResponse } from "next/server";
import { clearSession, getCurrentUser } from "@/lib/auth/session";
import { audit } from "@/lib/audit";

export async function POST() {
  const user = await getCurrentUser();
  await clearSession();
  if (user) await audit({ actor: user, action: "auth.logout", entityType: "user", entityId: user.id });
  return NextResponse.json({ data: null });
}
