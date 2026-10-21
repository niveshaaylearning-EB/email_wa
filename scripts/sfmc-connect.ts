/**
 * Configure (or update) the live Salesforce Marketing Cloud connection from the command line,
 * then run the read-only connection test and Business Unit discovery.
 *
 *   SFMC_AUTH_BASE_URI=https://mc….auth.marketingcloudapis.com/ SFMC_CLIENT_ID=… SFMC_CLIENT_SECRET=… npm run sfmc:connect
 *   (optional SFMC_MID=<business unit MID>)
 *
 * The secret is stored AES-256-GCM encrypted; nothing secret is printed. Only read calls are made.
 */
import "dotenv/config";
import { prisma } from "@/lib/db";
import { ensureRoles } from "@/lib/services/users";
import { discoverBusinessUnits, saveConnection, testConnection } from "@/lib/services/salesforce/connections";

async function main() {
  const authBaseUri = process.env.SFMC_AUTH_BASE_URI;
  const clientId = process.env.SFMC_CLIENT_ID;
  const clientSecret = process.env.SFMC_CLIENT_SECRET;
  if (!authBaseUri || !clientId) throw new Error("Set SFMC_AUTH_BASE_URI and SFMC_CLIENT_ID (and SFMC_CLIENT_SECRET on first setup).");
  await ensureRoles();
  const admin = await prisma.user.findFirst({ where: { role: { key: "ADMIN" }, isActive: true, deletedAt: null }, orderBy: { createdAt: "asc" } });
  const actor = admin ? { id: admin.id, email: admin.email } : { id: "cli", email: "cli" };
  const existing = await prisma.salesforceConnection.findFirst({ where: { kind: "LIVE", archivedAt: null }, orderBy: { createdAt: "asc" } });
  const conn = await saveConnection(
    existing?.id ?? null,
    { name: existing?.name ?? "Niveshaay Marketing Cloud", kind: "LIVE", authBaseUri, defaultMid: process.env.SFMC_MID ?? existing?.defaultMid ?? "", clientId, ...(clientSecret ? { clientSecret } : {}) },
    actor,
  );
  console.log(`connection ${existing ? "updated" : "created"}: ${conn.id}`);

  const r = await testConnection(conn.id, actor);
  if (!r.ok) {
    console.log(`TEST FAILED: ${"message" in r ? r.message : ""}\nhint: ${"hint" in r ? r.hint : ""}`);
    process.exitCode = 1;
    return;
  }
  console.log(`authenticated in ${r.latencyMs} ms · token MID ${r.memberId ?? "?"}`);
  console.log(`granted scopes: ${r.scopes.join(", ")}`);
  if (r.missingScopes.length) console.log(`missing recommended scopes: ${r.missingScopes.join(", ")}`);
  for (const c of Object.values(r.capabilities)) console.log(`  ${c.status === "ok" ? "OK    " : c.status.toUpperCase().padEnd(6)} ${c.label.padEnd(20)} ${c.message ?? ""}`);

  const bu = await discoverBusinessUnits(conn.id, actor);
  if (bu.warning) console.log(`BU discovery: ${bu.warning}`);
  const units = await prisma.salesforceBusinessUnit.findMany({ where: { connectionId: conn.id }, orderBy: [{ isEnterprise: "desc" }, { name: "asc" }] });
  console.log(`business units (${bu.method}):`);
  for (const u of units) console.log(`  ${u.mid.padEnd(12)} ${u.name}${u.isEnterprise ? " [enterprise]" : ""}${u.parentMid ? ` (parent ${u.parentMid})` : ""}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
