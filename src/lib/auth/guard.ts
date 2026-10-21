import "server-only";
import { redirect } from "next/navigation";
import { getCurrentUser, type SessionUser } from "./session";
import { hasPermission, type Permission } from "./permissions";
import { forbidden, unauthorized } from "@/lib/errors";

/** For server components/pages: redirect to login, or render 403 via error boundary. */
export async function requirePageUser(permission?: Permission): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (permission && !hasPermission(user.role, permission)) throw forbidden();
  return user;
}

/** For API routes/services: throw typed errors. */
export async function requireApiUser(permission?: Permission): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw unauthorized();
  if (permission && !hasPermission(user.role, permission)) throw forbidden();
  return user;
}

export function assertPermission(user: SessionUser, permission: Permission) {
  if (!hasPermission(user.role, permission)) throw forbidden();
}
