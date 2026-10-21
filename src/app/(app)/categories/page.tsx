import Link from "next/link";
import { ArchiveIcon, FileTextIcon, SparklesIcon, TagsIcon, UsersIcon, SendIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { listCategories } from "@/lib/services/categories";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/empty-state";
import { UrlSearch } from "@/components/app/url-controls";
import { Pill } from "@/components/app/status";
import { CategoryFormDialog } from "./category-form";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/db";
import { ArchivedToggle } from "./archived-toggle";

export const metadata = { title: "Categories" };

export default async function CategoriesPage({ searchParams }: PageProps<"/categories">) {
  const user = await requirePageUser("categories:read");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const showArchived = sp.archived === "1";
  const [cats, overlap] = await Promise.all([
    listCategories({ q, includeArchived: showArchived }),
    prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n FROM (SELECT client_id FROM client_categories cc JOIN categories c ON c.id = cc.category_id WHERE cc.removed_at IS NULL AND c.archived_at IS NULL GROUP BY client_id HAVING COUNT(*) > 1) t`,
  ]);
  const canWrite = hasPermission(user.role, "categories:write");
  const totalMembers = cats.filter((c) => !c.archivedAt).reduce((n, c) => n + c.memberCount, 0);

  return (
    <div className="animate-in-fade">
      <PageHeader
        title="Categories"
        description="Dashboard-owned audience groups. Clients can belong to many categories; CRM sync never changes memberships."
        actions={canWrite && <CategoryFormDialog />}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <UrlSearch placeholder="Search categories" />
        <ArchivedToggle checked={showArchived} />
        <p className="ml-auto text-xs text-muted-foreground">
          {cats.filter((c) => !c.archivedAt).length} active · {totalMembers.toLocaleString("en-IN")} memberships · {Number(overlap[0]?.n ?? 0).toLocaleString("en-IN")} clients in more than one category
        </p>
      </div>
      {cats.length === 0 ? (
        <EmptyState
          icon={TagsIcon}
          title={q ? "No categories match your search" : "No categories yet"}
          description="Create categories such as “Premium Research” or “Event Invitees”, then add clients manually, by CSV, or with a dynamic rule."
          action={canWrite && !q && <CategoryFormDialog />}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {cats.map((c) => (
            <Link
              key={c.id}
              href={`/categories/${c.id}`}
              className="group relative flex flex-col gap-4 overflow-hidden rounded-xl border bg-card p-4 transition-all hover:border-foreground/15 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="absolute inset-y-0 left-0 w-1" style={{ background: c.color }} aria-hidden />
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{c.name}</p>
                  <p className="mt-0.5 line-clamp-2 min-h-10 text-sm text-muted-foreground">{c.description || "No description"}</p>
                </div>
                {c.archivedAt ? (
                  <Pill tone="muted">
                    <ArchiveIcon className="size-3" /> Archived
                  </Pill>
                ) : (
                  <span className="tabular rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground" title="Default precedence (lower wins)">
                    P{c.priority}
                  </span>
                )}
              </div>
              <div className="flex items-end justify-between gap-2">
                <div>
                  <p className="tabular text-2xl font-semibold tracking-tight">{c.memberCount.toLocaleString("en-IN")}</p>
                  <p className="flex items-center gap-1 text-xs text-muted-foreground">
                    <UsersIcon className="size-3" /> members
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-1.5 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5" title="Mapped templates">
                    <FileTextIcon className="size-3" /> {c.templates.length}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5" title="Campaigns">
                    <SendIcon className="size-3" /> {c.campaignCount}
                  </span>
                  {c.ruleCount > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5" title="Dynamic rules">
                      <SparklesIcon className="size-3" /> {c.ruleCount}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
