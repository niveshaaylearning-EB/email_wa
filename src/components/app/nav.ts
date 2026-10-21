import {
  ActivityIcon,
  BarChart3Icon,
  CalendarClockIcon,
  CheckCheckIcon,
  FileTextIcon,
  LayoutDashboardIcon,
  PlugIcon,
  SendIcon,
  SettingsIcon,
  TagsIcon,
  UsersIcon,
  ArchiveIcon,
  DatabaseBackupIcon,
  Table2Icon,
  MailSearchIcon,
  UserSearchIcon,
  WorkflowIcon,
  LayoutTemplateIcon,
  ScaleIcon,
  BadgeCheckIcon,
  ScrollTextIcon,
  CloudCogIcon,
  BotIcon,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@/lib/auth/permissions";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  permission: Permission;
  badge?: "approvals" | "scheduled";
  /** Only active on an exact path match (section landing pages). */
  exact?: boolean;
}

export const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Workspace",
    items: [
      { title: "Overview", href: "/", icon: LayoutDashboardIcon, permission: "analytics:read" },
      { title: "Clients", href: "/clients", icon: UsersIcon, permission: "clients:read" },
      { title: "Categories", href: "/categories", icon: TagsIcon, permission: "categories:read" },
      { title: "Templates", href: "/templates", icon: FileTextIcon, permission: "templates:read" },
    ],
  },
  {
    label: "Campaigns",
    items: [
      { title: "Campaign Studio", href: "/campaigns", icon: SendIcon, permission: "campaigns:read" },
      { title: "Scheduled", href: "/scheduled", icon: CalendarClockIcon, permission: "campaigns:read", badge: "scheduled" },
      { title: "Approvals", href: "/approvals", icon: CheckCheckIcon, permission: "campaigns:read", badge: "approvals" },
      { title: "Analytics", href: "/analytics", icon: BarChart3Icon, permission: "analytics:read" },
    ],
  },
  {
    label: "Administration",
    items: [
      { title: "Activity Logs", href: "/activity", icon: ActivityIcon, permission: "audit:read" },
      { title: "Integrations", href: "/integrations", icon: PlugIcon, permission: "integrations:read" },
      // TEST MODULE — remove after testing (docs/doubletick-onboarding-test.md)
      { title: "Onboarding bot (test)", href: "/automations/onboarding", icon: BotIcon, permission: "integrations:write" },
      { title: "Settings", href: "/settings", icon: SettingsIcon, permission: "campaigns:read" },
    ],
  },
  {
    // Read-only archive of the legacy Salesforce Marketing Cloud account (SEBI audit evidence).
    label: "Salesforce Archive",
    items: [
      { title: "Archive Overview", href: "/salesforce", icon: ArchiveIcon, permission: "archive:read", exact: true },
      { title: "Backup Center", href: "/salesforce/backups", icon: DatabaseBackupIcon, permission: "archive:read" },
      { title: "Data Extensions", href: "/salesforce/data-extensions", icon: Table2Icon, permission: "archive:read" },
      { title: "Email Campaign Archive", href: "/salesforce/campaigns", icon: MailSearchIcon, permission: "archive:read" },
      { title: "Recipient Tracking", href: "/salesforce/tracking", icon: UserSearchIcon, permission: "archive:read" },
      { title: "Journey & Automation", href: "/salesforce/journeys", icon: WorkflowIcon, permission: "archive:read" },
      { title: "Template Archive", href: "/salesforce/templates", icon: LayoutTemplateIcon, permission: "archive:read" },
      { title: "SEBI Audit Center", href: "/salesforce/audit", icon: ScaleIcon, permission: "archive:read" },
      { title: "Backup Verification", href: "/salesforce/verification", icon: BadgeCheckIcon, permission: "archive:read" },
      { title: "Extraction Logs", href: "/salesforce/logs", icon: ScrollTextIcon, permission: "archive:read" },
      { title: "Salesforce Connection", href: "/salesforce/connection", icon: CloudCogIcon, permission: "archive:read" },
    ],
  },
];

export function isActive(pathname: string, href: string, exact = false) {
  return href === "/" || exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}
