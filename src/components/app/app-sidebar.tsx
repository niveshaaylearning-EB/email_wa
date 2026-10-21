"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { BrandMark } from "./brand";
import { NAV_GROUPS, isActive } from "./nav";
import type { Permission, RoleKey } from "@/lib/auth/permissions";
import { ROLE_LABELS } from "@/lib/auth/permissions";

export function AppSidebar({
  user,
  permissions,
  counts,
}: {
  user: { name: string; email: string; role: RoleKey };
  permissions: Permission[];
  counts: { approvals: number; scheduled: number };
}) {
  const pathname = usePathname();
  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="px-3 pb-2 pt-4">
        <Link href="/" className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring">
          <BrandMark className="group-data-[collapsible=icon]:hidden" />
          <BrandMark compact className="hidden group-data-[collapsible=icon]:flex" />
        </Link>
      </SidebarHeader>
      <SidebarContent className="px-1">
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter((i) => permissions.includes(i.permission));
          if (!items.length) return null;
          return (
            <SidebarGroup key={group.label}>
              <SidebarGroupLabel className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">{group.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((item) => {
                    const active = isActive(pathname, item.href, item.exact);
                    const count = item.badge ? counts[item.badge] : 0;
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton asChild isActive={active} tooltip={item.title} className="h-9 data-[active=true]:font-medium">
                          <Link href={item.href}>
                            <item.icon />
                            <span>{item.title}</span>
                          </Link>
                        </SidebarMenuButton>
                        {count > 0 && (
                          <SidebarMenuBadge className={item.badge === "approvals" ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground"}>{count}</SidebarMenuBadge>
                        )}
                      </SidebarMenuItem>
                    );
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>
      <SidebarFooter className="p-3 group-data-[collapsible=icon]:hidden">
        <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/50 px-3 py-2.5">
          <p className="truncate text-sm font-medium text-sidebar-accent-foreground">{user.name}</p>
          <p className="truncate text-xs text-muted-foreground">{ROLE_LABELS[user.role]}</p>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
