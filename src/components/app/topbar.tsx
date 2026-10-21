"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { LogOutIcon, MonitorIcon, MoonIcon, SearchIcon, ShieldAlertIcon, ShieldCheckIcon, SunIcon, FlaskConicalIcon } from "lucide-react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { NAV_GROUPS } from "./nav";
import { api } from "@/lib/client/api";
import { ROLE_LABELS, hasPermission, type RoleKey } from "@/lib/auth/permissions";

export function Topbar({
  user,
  sendModes,
  liveSendEnabled,
  mockData,
}: {
  user: { name: string; email: string; role: RoleKey };
  sendModes: { label: string; mode: "MOCK" | "DRY_RUN" | "LIVE" }[];
  liveSendEnabled: boolean;
  mockData: boolean;
}) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const anyLive = liveSendEnabled && sendModes.some((m) => m.mode === "LIVE");
  const initials = user.name
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 md:px-6">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mx-1 h-5" />
      <button
        onClick={() => setOpen(true)}
        className="flex h-8 w-full max-w-sm items-center gap-2 rounded-lg border bg-surface px-3 text-sm text-muted-foreground transition-colors hover:bg-muted"
      >
        <SearchIcon className="size-4" />
        <span className="flex-1 text-left">Search clients, pages…</span>
        <kbd className="hidden rounded border bg-muted px-1.5 font-mono text-[10px] sm:inline">Ctrl K</kbd>
      </button>
      <div className="ml-auto flex items-center gap-2">
        {mockData && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="hidden gap-1 border-warning/40 bg-warning/10 text-warning md:inline-flex">
                <FlaskConicalIcon className="size-3" /> Mock data
              </Badge>
            </TooltipTrigger>
            <TooltipContent>Development dataset is loaded. Mock clients and simulated deliveries are labelled throughout.</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="outline"
              className={anyLive ? "gap-1 border-destructive/40 bg-destructive/10 text-destructive" : "gap-1 border-success/40 bg-success/10 text-success"}
            >
              {anyLive ? <ShieldAlertIcon className="size-3" /> : <ShieldCheckIcon className="size-3" />}
              {anyLive ? "Live sending" : "Safe mode"}
            </Badge>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <p className="font-medium">Send safety</p>
            <p>Deployment live-send switch: {liveSendEnabled ? "ON" : "OFF"}</p>
            {sendModes.map((m) => (
              <p key={m.label}>
                {m.label}: {m.mode.replace("_", "-")}
              </p>
            ))}
          </TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-9 gap-2 px-1.5">
              <Avatar className="size-7">
                <AvatarFallback className="bg-brand text-[11px] font-medium text-white">{initials}</AvatarFallback>
              </Avatar>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuLabel className="font-normal">
              <p className="text-sm font-medium">{user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{user.email}</p>
              <p className="mt-1 text-xs text-muted-foreground">{ROLE_LABELS[user.role]}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light">
                <SunIcon /> Light
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">
                <MoonIcon /> Dark
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">
                <MonitorIcon /> System
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={async () => {
                await api("/api/auth/logout", { method: "POST" });
                window.location.assign("/login");
              }}
            >
              <LogOutIcon /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <CommandDialog open={open} onOpenChange={setOpen} title="Search" description="Search clients or jump to a page">
        <CommandInput placeholder="Type a client name, email, phone or page…" value={q} onValueChange={setQ} />
        <CommandList>
          <CommandEmpty>No matches.</CommandEmpty>
          {q.trim().length >= 2 && (
            <CommandGroup heading="Clients">
              <CommandItem
                value={`search-clients-${q}`}
                onSelect={() => {
                  setOpen(false);
                  router.push(`/clients?q=${encodeURIComponent(q.trim())}`);
                }}
              >
                <SearchIcon /> Search clients for “{q.trim()}”
              </CommandItem>
            </CommandGroup>
          )}
          {NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => hasPermission(user.role, i.permission)) }))
            .filter((g) => g.items.length)
            .map((g) => (
            <CommandGroup key={g.label} heading={g.label}>
              {g.items.map((i) => (
                <CommandItem
                  key={i.href}
                  value={i.title}
                  onSelect={() => {
                    setOpen(false);
                    router.push(i.href);
                  }}
                >
                  <i.icon /> {i.title}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
    </header>
  );
}
