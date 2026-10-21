import { requirePageUser } from "@/lib/auth/guard";
import { ClientListQuerySchema } from "@/lib/contracts";
import { listClients } from "@/lib/services/clients";
import { listCategories } from "@/lib/services/categories";
import { PageHeader } from "@/components/app/page-header";
import { ClientsTable } from "./clients-table";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { relativeTime } from "@/lib/time";

export const metadata = { title: "Clients" };

export default async function ClientsPage({ searchParams }: PageProps<"/clients">) {
  const user = await requirePageUser("clients:read");
  const raw = Object.fromEntries(Object.entries(await searchParams).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const parsed = ClientListQuerySchema.safeParse(raw);
  const query = parsed.success ? parsed.data : ClientListQuerySchema.parse({});
  const [data, categories, statuses, lastSync] = await Promise.all([
    listClients(query),
    listCategories(),
    prisma.client.findMany({ where: { crmStatus: { not: null } }, distinct: ["crmStatus"], select: { crmStatus: true }, take: 50 }),
    prisma.integrationSetting.findUnique({ where: { provider: "ZOHO_CRM" }, select: { lastSyncAt: true } }),
  ]);
  return (
    <div className="animate-in-fade">
      <PageHeader
        title="Client directory"
        description={
          <>
            Mirrored from Zoho CRM (read-only contact data). Category memberships are managed here. Last CRM sync {relativeTime(lastSync?.lastSyncAt)}.
          </>
        }
      />
      <ClientsTable
        data={data}
        query={query}
        categories={categories.map((c) => ({ id: c.id, name: c.name, color: c.color }))}
        statuses={statuses.map((s) => s.crmStatus!).filter(Boolean)}
        canWrite={hasPermission(user.role, "clients:write")}
        canSync={hasPermission(user.role, "sync:run")}
      />
    </div>
  );
}
