import { requirePageUser } from "@/lib/auth/guard";
import { getAppSettings } from "@/lib/services/settings";
import { listTestRecipients, listUsers } from "@/lib/services/users";
import { prisma } from "@/lib/db";
import { PageHeader } from "@/components/app/page-header";
import { hasPermission, ROLE_DESCRIPTIONS, ROLE_LABELS, ROLE_PERMISSIONS, type RoleKey } from "@/lib/auth/permissions";
import { SettingsTabs } from "./settings-tabs";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requirePageUser("campaigns:read");
  const canManageUsers = hasPermission(user.role, "users:manage");
  const [settings, users, testRecipients, suppressions] = await Promise.all([
    getAppSettings(),
    canManageUsers ? listUsers() : Promise.resolve([]),
    listTestRecipients(),
    prisma.suppressionEntry.findMany({ where: { liftedAt: null }, orderBy: { createdAt: "desc" }, take: 300, include: { client: { select: { id: true, fullName: true } } } }),
  ]);
  return (
    <div className="animate-in-fade">
      <PageHeader title="Settings" description="Workspace configuration, compliance controls, users and roles." />
      <SettingsTabs
        settings={settings}
        canEdit={hasPermission(user.role, "settings:write")}
        canManageUsers={canManageUsers}
        canSuppress={hasPermission(user.role, "suppression:write")}
        currentUserId={user.id}
        users={users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role.key, isActive: u.isActive, lastLoginAt: u.lastLoginAt?.toISOString() ?? null }))}
        roles={(Object.keys(ROLE_LABELS) as RoleKey[]).map((k) => ({ key: k, label: ROLE_LABELS[k], description: ROLE_DESCRIPTIONS[k], permissions: [...ROLE_PERMISSIONS[k]] }))}
        testRecipients={testRecipients.map((r) => ({ id: r.id, name: r.name, email: r.email, phoneE164: r.phoneE164 }))}
        suppressions={suppressions.map((s) => ({ id: s.id, channel: s.channel, identifierType: s.identifierType, identifierValue: s.identifierValue, reason: s.reason, source: s.source, createdAt: s.createdAt.toISOString(), client: s.client }))}
      />
    </div>
  );
}
