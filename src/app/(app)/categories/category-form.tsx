"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Loader2Icon, PencilIcon, PlusIcon } from "lucide-react";
import type { z } from "zod";
import { CategoryCreateSchema } from "@/lib/contracts";
import { api, errorMessage } from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { cn } from "@/lib/utils";

const SWATCHES = ["#1E3A5F", "#0F8B6E", "#7C5CBF", "#D4A017", "#C2410C", "#2563EB", "#BE185D", "#475569"];
type Values = z.input<typeof CategoryCreateSchema>;

export function CategoryFormDialog({ category }: { category?: { id: string; name: string; description: string | null; color: string; priority: number } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const form = useForm<Values>({
    resolver: zodResolver(CategoryCreateSchema),
    defaultValues: category
      ? { name: category.name, description: category.description ?? "", color: category.color, priority: category.priority }
      : { name: "", description: "", color: SWATCHES[0], priority: 100 },
  });
  const color = form.watch("color");

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      if (category) {
        await api(`/api/v1/categories/${category.id}`, { method: "PATCH", body: values });
        toast.success("Category updated");
      } else {
        const c = await api<{ id: string }>("/api/v1/categories", { body: values });
        toast.success("Category created");
        router.push(`/categories/${c.id}`);
      }
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) form.reset();
      }}
    >
      <DialogTrigger asChild>
        {category ? (
          <Button variant="outline" size="sm">
            <PencilIcon /> Edit
          </Button>
        ) : (
          <Button>
            <PlusIcon /> New category
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{category ? "Edit category" : "New category"}</DialogTitle>
          <DialogDescription>Categories exist only in this dashboard and are never written to Zoho CRM.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <FieldGroup>
            <Field data-invalid={!!form.formState.errors.name}>
              <FieldLabel htmlFor="cat-name">Name</FieldLabel>
              <Input id="cat-name" {...form.register("name")} placeholder="e.g. Premium Research" autoFocus />
              <FieldError errors={[form.formState.errors.name]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="cat-desc">Description</FieldLabel>
              <Textarea id="cat-desc" rows={2} {...form.register("description")} placeholder="Who belongs here and why" />
            </Field>
            <div className="grid grid-cols-[1fr_120px] gap-4">
              <Field>
                <FieldLabel>Colour</FieldLabel>
                <div className="flex flex-wrap gap-2">
                  {SWATCHES.map((s) => (
                    <button
                      type="button"
                      key={s}
                      aria-label={`Colour ${s}`}
                      onClick={() => form.setValue("color", s, { shouldDirty: true })}
                      className={cn("size-7 rounded-full ring-offset-2 ring-offset-background transition", color?.toLowerCase() === s.toLowerCase() && "ring-2 ring-foreground/60")}
                      style={{ background: s }}
                    />
                  ))}
                </div>
              </Field>
              <Field data-invalid={!!form.formState.errors.priority}>
                <FieldLabel htmlFor="cat-priority">Priority</FieldLabel>
                <Input id="cat-priority" type="number" min={1} max={1000} {...form.register("priority")} />
                <FieldDescription className="text-xs">Lower = higher precedence</FieldDescription>
              </Field>
            </div>
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Loader2Icon className="animate-spin" />}
              {category ? "Save changes" : "Create category"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
