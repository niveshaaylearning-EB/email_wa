import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/session";
import type { RoleKey } from "@/lib/auth/permissions";
import { clearInlineQueue } from "@/lib/queue";
import { clearProviderOverrides } from "@/lib/providers/registry";

const TABLES = [
  "delivery_events",
  "message_deliveries",
  "campaign_message_assignments",
  "campaign_recipients",
  "campaign_snapshots",
  "campaign_categories",
  "campaigns",
  "category_templates",
  "template_versions",
  "templates",
  "membership_events",
  "client_categories",
  "category_rules",
  "categories",
  "consents",
  "suppression_entries",
  "clients",
  "webhook_events",
  "sync_runs",
  "integration_settings",
  "audit_logs",
  "sessions",
  "users",
  "roles",
  "app_settings",
  "internal_test_recipients",
  // Salesforce archive
  "salesforce_reconciliation_results",
  "salesforce_reconciliation_jobs",
  "salesforce_evidence_packages",
  "salesforce_tracking_events",
  "salesforce_data_extension_rows",
  "salesforce_data_extension_fields",
  "salesforce_data_extensions",
  "salesforce_subscribers",
  "salesforce_email_jobs",
  "salesforce_assets",
  "salesforce_emails",
  "salesforce_content_files",
  "salesforce_journeys",
  "salesforce_automations",
  "salesforce_backup_manifests",
  "salesforce_backup_pages",
  "salesforce_backup_datasets",
  "salesforce_backup_jobs",
  "salesforce_backup_schedules",
  "salesforce_business_units",
  "salesforce_extraction_errors",
  "salesforce_extraction_logs",
  "salesforce_archive_audit_logs",
  "salesforce_connections",
];

export async function resetDb() {
  if (!process.env.DATABASE_URL?.includes("_test")) throw new Error("Refusing to reset a non-test database");
  // TRUNCATE does not fire row-level immutability triggers.
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`);
  clearInlineQueue();
  clearProviderOverrides();
  const { clearSimulators } = await import("@/lib/services/salesforce/connections");
  clearSimulators();
}

export async function createUser(role: RoleKey, email = `${role.toLowerCase()}@test.local`) {
  const r = await prisma.role.upsert({ where: { key: role }, create: { key: role, name: role }, update: {} });
  const u = await prisma.user.create({ data: { email, name: role, passwordHash: await hashPassword("Password1234"), roleId: r.id } });
  return { id: u.id, email: u.email, name: u.name, role, sessionId: "test" };
}

let n = 0;
export async function createClient(over: Partial<Parameters<typeof prisma.client.create>[0]["data"]> = {}) {
  n++;
  return prisma.client.create({
    data: {
      zohoCrmId: `T-${Date.now()}-${n}`,
      fullName: `Client ${n}`,
      firstName: `First${n}`,
      email: `c${n}@example.com`,
      emailNormalized: `c${n}@example.com`,
      phoneRaw: `98765${String(n).padStart(5, "0")}`,
      phoneE164: `+9198765${String(n).padStart(5, "0")}`,
      phoneValid: true,
      crmStatus: "Active",
      ...over,
    },
  });
}

export async function grantConsent(clientId: string, channel: "EMAIL" | "WHATSAPP" = "WHATSAPP") {
  return prisma.consent.create({ data: { clientId, channel, status: "GRANTED", source: "MANUAL", evidence: "test" } });
}
