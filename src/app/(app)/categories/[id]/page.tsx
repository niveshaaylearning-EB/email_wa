import { getCurrentUser } from "@/lib/auth/session";
import { prisma } from "@/lib/db";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon, ArchiveIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { getCategoryDetail } from "@/lib/services/categories";
import { listClients } from "@/lib/services/clients";
import { listTemplates } from "@/lib/services/templates";
import { ClientListQuerySchema } from "@/lib/contracts";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/app/empty-state";
import { Pill } from "@/components/app/status";
import { hasPermission } from "@/lib/auth/permissions";
import { CategoryFormDialog } from "../category-form";
import { CategoryDetailTabs } from "./detail-tabs";
import { CategoryHeaderActions } from "./header-actions";
import { RuleDefinitionSchema, describeRule } from "@/lib/domain/rules";
import { formatIST } from "@/lib/time";

export async function generateMetadata({ params }: PageProps<"/categories/[id]">) {
  if (!(await getCurrentUser())) return { title: "Sign in" };
  const { id } = await params;
  const r = await prisma.category.findUnique({ where: { id }, select: { name: true } });
  return { title: r?.name ?? "Not found" };
}

export default async function CategoryDetailPage({ params, searchParams }: PageProps<"/categories/[id]">) {
  const user = await requirePageUser("categories:read");
  const { id } = await params;
  const sp = await searchParams;
  const c = await getCategoryDetail(id);
  if (!c) notFound();
  const q = ClientListQuerySchema.parse({ q: typeof sp.q === "string" ? sp.q : undefined, page: typeof sp.page === "string" ? sp.page : undefined, categoryId: id, pageSize: 25 });
  const [members, allTemplates] = await Promise.all([listClients(q), listTemplates()]);
  const canWrite = hasPermission(user.role, "categories:write") && !c.archivedAt;
  const canMapTemplates = hasPermission(user.role, "templates:write") && !c.archivedAt;

  return (
    <div className="animate-in-fade space-y-5">
      <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
        <Link href="/categories">
          <ArrowLeftIcon /> Categories
        </Link>
      </Button>
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="size-3 rounded-full" style={{ background: c.color }} />
            {c.name}
            {c.archivedAt && (
              <Pill tone="muted">
                <ArchiveIcon className="size-3" /> Archived
              </Pill>
            )}
          </span>
        }
        description={c.description || "No description"}
        eyebrow={`Created by ${c.createdBy?.name ?? "system"} · default priority ${c.priority}`}
        actions={
          hasPermission(user.role, "categories:write") && (
            <>
              {!c.archivedAt && <CategoryFormDialog category={{ id: c.id, name: c.name, description: c.description, color: c.color, priority: c.priority }} />}
              <CategoryHeaderActions categoryId={c.id} archived={!!c.archivedAt} name={c.name} />
            </>
          )
        }
      />
      {c.archivedAt && <Notice tone="info" title="Archived category">Archived on {formatIST(c.archivedAt)}. Memberships and campaign history are preserved; it cannot be selected for new campaigns.</Notice>}

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {[
          ["Members", c.memberCount],
          ["Manual", c.sourceBreakdown.MANUAL ?? 0],
          ["Bulk", c.sourceBreakdown.BULK ?? 0],
          ["CSV import", c.sourceBreakdown.CSV ?? 0],
          ["Dynamic rule", c.sourceBreakdown.RULE ?? 0],
        ].map(([l, v]) => (
          <div key={l as string} className="rounded-xl border bg-card px-4 py-3">
            <dt className="text-xs text-muted-foreground">{l}</dt>
            <dd className="tabular mt-1 text-xl font-semibold">{Number(v).toLocaleString("en-IN")}</dd>
          </div>
        ))}
      </dl>

      <CategoryDetailTabs
        categoryId={c.id}
        canWrite={canWrite}
        canMapTemplates={canMapTemplates}
        members={members}
        rules={c.rules.map((r) => {
          const def = RuleDefinitionSchema.safeParse(r.definition);
          return { id: r.id, name: r.name, isActive: r.isActive, autoRemove: r.autoRemove, description: def.success ? describeRule(def.data) : "Invalid definition", lastEvaluatedAt: r.lastEvaluatedAt?.toISOString() ?? null, lastMatchCount: r.lastMatchCount };
        })}
        mappedTemplates={c.templates.filter((t) => !t.removedAt).map((t) => ({ id: t.template.id, name: t.template.name, channel: t.template.channel, approvalStatus: t.template.approvalStatus, isDefault: t.isDefault, providerTemplateId: t.template.providerTemplateId }))}
        availableTemplates={allTemplates.map((t) => ({ id: t.id, name: t.name, channel: t.channel, approvalStatus: t.approvalStatus }))}
        campaigns={c.campaigns.map((cc) => ({ id: cc.campaign.id, name: cc.campaign.name, status: cc.campaign.status, channelMode: cc.campaign.channelMode, createdAt: cc.campaign.createdAt.toISOString(), memberCountAtSnapshot: cc.memberCountAtSnapshot }))}
        events={c.events.map((e) => ({ id: e.id, action: e.action, source: e.source, note: e.note, createdAt: e.createdAt.toISOString(), client: e.client, actor: e.actor?.name ?? null }))}
      />
    </div>
  );
}
