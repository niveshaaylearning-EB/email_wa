"use client";

import { useState } from "react";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { CategoryChip } from "./status";
import { cn } from "@/lib/utils";

export interface CategoryOption {
  id: string;
  name: string;
  color: string;
}

export function CategoryMultiPicker({
  options,
  value,
  onChange,
  placeholder = "Select categories",
  className,
}: {
  options: CategoryOption[];
  value: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.filter((o) => value.includes(o.id));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} className={cn("h-auto min-h-9 w-full justify-between py-1.5", className)}>
          <span className="flex flex-wrap gap-1">
            {selected.length ? selected.map((s) => <CategoryChip key={s.id} name={s.name} color={s.color} />) : <span className="font-normal text-muted-foreground">{placeholder}</span>}
          </span>
          <ChevronsUpDownIcon className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search categories…" />
          <CommandList>
            <CommandEmpty>No categories found.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => {
                const on = value.includes(o.id);
                return (
                  <CommandItem key={o.id} value={o.name} onSelect={() => onChange(on ? value.filter((v) => v !== o.id) : [...value, o.id])}>
                    <span className="size-2.5 rounded-full" style={{ background: o.color }} />
                    <span className="flex-1">{o.name}</span>
                    <CheckIcon className={cn("size-4", on ? "opacity-100" : "opacity-0")} />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
