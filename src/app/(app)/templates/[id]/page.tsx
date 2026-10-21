import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { getTemplateDetail } from "@/lib/services/templates";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CategoryChip, ChannelBadge } from "@/components/app/status";
import { hasPermission } from "@/lib/auth/permissions";
import { formatIST } from "@/lib/time";
import { TemplateEditor } from "../template-editor";
import type { TemplateVariable, WhatsAppHeader } from "@/lib/domain/template-render";

export async function generateMetadata({ params }: PageProps<"/templates/[id]">) {
  if (!(await getCurrentUser())) return { title: "Sign in" };
  const { id } = await params;
  const r = await prisma.template.findUnique({ where: { id }, select: { name: true } });
  return { title: r?.name ?? "Not found" };
}

export default async function TemplateDetailPage({ params }: PageProps<"/templates/[id]">) {
  const user = await requirePageUser("templates:read");
  const { id } = await params;
  const t = await getTemplateDetail(id);
  if (!t) notFound();
  const canWrite = hasPermission(user.role, "templates:write") && !t.archivedAt;
  return (
    <div className="animate-in-fade space-y-5">
      <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
        <Link href="/templates">
          <ArrowLeftIcon /> Templates
        </Link>
      </Button>
      <PageHeader title={t.name} eyebrow={<ChannelBadge channel={t.channel} />} description={`Version ${t.currentVersion} · last updated ${formatIST(t.updatedAt)}`} />
      <TemplateEditor
        readOnly={!canWrite}
        template={{
          id: t.id,
          channel: t.channel,
          name: t.name,
          description: t.description ?? "",
          providerTemplateId: t.providerTemplateId ?? "",
          language: t.language ?? "",
          subject: t.subject ?? "",
          senderName: t.senderName ?? "",
          body: t.body,
          header: (t.header as WhatsAppHeader | null) ?? null,
          variables: (t.variables as TemplateVariable[]) ?? [],
          approvalStatus: t.approvalStatus,
        }}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Authorised categories</CardTitle>
            <CardDescription className="text-xs">Manage mappings from each category’s Templates tab.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1.5">
            {t.categories.filter((c) => !c.removedAt).length ? (
              t.categories
                .filter((c) => !c.removedAt)
                .map((c) => (
                  <Link key={c.id} href={`/categories/${c.category.id}`}>
                    <CategoryChip name={`${c.category.name}${c.isDefault ? " (default)" : ""}`} color={c.category.color} />
                  </Link>
                ))
            ) : (
              <p className="text-sm text-muted-foreground">Not mapped to any category yet.</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-semibold">Version history</CardTitle>
            <CardDescription className="text-xs">Approved campaigns reference the exact version they were frozen with.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="space-y-2 text-sm">
              {t.versions.map((v) => (
                <li key={v.id} className="flex items-baseline justify-between gap-3">
                  <span>
                    <span className="font-medium">v{v.version}</span> <span className="text-muted-foreground">{v.changeNote ?? ""}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {v.createdBy?.name ?? "system"} · {formatIST(v.createdAt)} · <span className="font-mono">{v.contentHash.slice(0, 8)}</span>
                  </span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
