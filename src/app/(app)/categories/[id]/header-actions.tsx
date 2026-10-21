"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArchiveIcon, ArchiveRestoreIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { api, errorMessage } from "@/lib/client/api";

export function CategoryHeaderActions({ categoryId, archived, name }: { categoryId: string; archived: boolean; name: string }) {
  const router = useRouter();
  if (archived) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          try {
            await api(`/api/v1/categories/${categoryId}/restore`, { method: "POST" });
            toast.success("Category restored");
            router.refresh();
          } catch (e) {
            toast.error(errorMessage(e));
          }
        }}
      >
        <ArchiveRestoreIcon /> Restore
      </Button>
    );
  }
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm">
          <ArchiveIcon /> Archive
        </Button>
      }
      title={`Archive “${name}”?`}
      description={
        <>
          <p>Archived categories can’t be used in new campaigns. Memberships, template mappings and all historical campaign data are preserved — nothing is deleted.</p>
          <p>Archiving is blocked while an active campaign uses this category.</p>
        </>
      }
      confirmLabel="Archive category"
      destructive
      onConfirm={async () => {
        try {
          await api(`/api/v1/categories/${categoryId}/archive`, { method: "POST" });
          toast.success("Category archived");
          router.refresh();
        } catch (e) {
          toast.error(errorMessage(e));
          throw e;
        }
      }}
    />
  );
}
