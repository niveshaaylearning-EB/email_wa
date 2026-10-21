import "server-only";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import argon2 from "argon2";
import { prisma } from "@/lib/db";
import { randomToken, sha256 } from "@/lib/crypto";
import { env } from "@/lib/env";
import type { RoleKey } from "./permissions";

export const SESSION_COOKIE = "ncc_session";
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: RoleKey;
  sessionId: string;
}

export async function hashPassword(password: string) {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string) {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export type LoginResult = { ok: true; user: SessionUser; token: string; expiresAt: Date } | { ok: false; reason: string };

export async function authenticate(email: string, password: string, meta: { ip?: string; userAgent?: string }): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, include: { role: true } });
  const generic = "Invalid email or password.";
  if (!user || !user.isActive || user.deletedAt) {
    await argon2.hash(password).catch(() => undefined); // equalise timing
    return { ok: false, reason: generic };
  }
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { ok: false, reason: "Account temporarily locked after repeated failed sign-ins. Try again later." };
  }
  if (!(await verifyPassword(user.passwordHash, password))) {
    const failed = user.failedLogins + 1;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLogins: failed >= MAX_FAILED_LOGINS ? 0 : failed,
        lockedUntil: failed >= MAX_FAILED_LOGINS ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      },
    });
    return { ok: false, reason: generic };
  }
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + env().SESSION_TTL_HOURS * 3600_000);
  const session = await prisma.session.create({
    data: { tokenHash: sha256(token), userId: user.id, expiresAt, ipAddress: meta.ip, userAgent: meta.userAgent?.slice(0, 300) },
  });
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
  return {
    ok: true,
    token,
    expiresAt,
    user: { id: user.id, email: user.email, name: user.name, role: user.role.key, sessionId: session.id },
  };
}

export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { tokenHash: sha256(token) } });
  jar.delete(SESSION_COOKIE);
}

/** Resolve the current user from the session cookie (memoised per request). */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: { include: { role: true } } },
  });
  if (!session || session.expiresAt < new Date() || !session.user.isActive || session.user.deletedAt) return null;
  if (Date.now() - session.lastSeenAt.getTime() > 5 * 60_000) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  }
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role.key,
    sessionId: session.id,
  };
});

export async function requestMeta() {
  const h = await headers();
  return {
    ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? undefined,
    userAgent: h.get("user-agent") ?? undefined,
  };
}
