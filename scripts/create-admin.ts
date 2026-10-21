/**
 * Create (or re-activate) an administrator. Production-safe; no mock data.
 *   ADMIN_EMAIL=you@niveshaay.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='…' npm run admin:create
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";
import { ensureRoles } from "../src/lib/services/users";
import { hashPassword } from "../src/lib/auth/session";
import { UserCreateSchema } from "../src/lib/contracts";

const input = UserCreateSchema.parse({
  email: process.env.ADMIN_EMAIL,
  name: process.env.ADMIN_NAME ?? "Administrator",
  role: "ADMIN",
  password: process.env.ADMIN_PASSWORD,
});

async function main() {
  await ensureRoles();
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  const user = await prisma.user.upsert({
    where: { email: input.email },
    create: { email: input.email, name: input.name, roleId: role.id, passwordHash: await hashPassword(input.password) },
    update: { roleId: role.id, isActive: true, deletedAt: null, passwordHash: await hashPassword(input.password), failedLogins: 0, lockedUntil: null },
  });
  await prisma.auditLog.create({ data: { actorEmail: "cli", action: "user.admin_bootstrap", entityType: "user", entityId: user.id, metadata: {} } });
  console.log(`Administrator ready: ${user.email}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
