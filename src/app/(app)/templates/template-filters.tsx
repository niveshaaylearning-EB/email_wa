"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUrlParams } from "@/components/app/url-controls";

export function TemplateFilters({ categories }: { categories: { id: string; name: string }[] }) {
  const { params, set } = useUrlParams();
  return (
    <>
      <Select value={params.get("channel") ?? "__all"} onValueChange={(v) => set({ channel: v === "__all" ? null : v })}>
        <SelectTrigger className="h-9 w-full bg-surface sm:w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">All channels</SelectItem>
          <SelectItem value="EMAIL">Email</SelectItem>
          <SelectItem value="WHATSAPP">WhatsApp</SelectItem>
        </SelectContent>
      </Select>
      <Select value={params.get("categoryId") ?? "__all"} onValueChange={(v) => set({ categoryId: v === "__all" ? null : v })}>
        <SelectTrigger className="h-9 w-full bg-surface sm:w-52">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">All categories</SelectItem>
          {categories.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </>
  );
}
