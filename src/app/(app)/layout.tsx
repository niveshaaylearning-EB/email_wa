import { requirePageUser } from "@/lib/auth/guard";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app/app-sidebar";
import { Topbar } from "@/components/app/topbar";
import { prisma } from "@/lib/db";
import { ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import { listIntegrationsForUi } from "@/lib/services/integrations";
import { env } from "@/lib/env";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requirePageUser();
  const [pendingApprovals, scheduled, integrations, mockClients] = await Promise.all([
    prisma.campaign.count({ where: { status: "PENDING_APPROVAL", deletedAt: null } }),
    prisma.campaign.count({ where: { status: "SCHEDULED", deletedAt: null } }),
    listIntegrationsForUi(),
    prisma.client.count({ where: { isMock: true } }),
  ]);
  const sendModes = integrations.filter((i) => i.provider !== "ZOHO_CRM").map((i) => ({ label: i.label, mode: i.mode }));
  return (
    <SidebarProvider>
      <AppSidebar
        user={{ name: user.name, email: user.email, role: user.role }}
        permissions={[...ROLE_PERMISSIONS[user.role]]}
        counts={{ approvals: pendingApprovals, scheduled }}
      />
      <SidebarInset className="min-w-0 bg-background">
        <Topbar
          user={{ name: user.name, email: user.email, role: user.role }}
          sendModes={sendModes}
          liveSendEnabled={env().ALLOW_LIVE_SEND}
          mockData={mockClients > 0}
        />
        <div className="mx-auto w-full max-w-[1440px] flex-1 px-4 pb-16 pt-6 md:px-8">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
