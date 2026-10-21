import Link from "next/link";
import { AlertTriangleIcon, FileTextIcon, PlusIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { listTemplates } from "@/lib/services/templates";
import { listCategories } from "@/lib/services/categories";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CategoryChip, ChannelBadge, Pill } from "@/components/app/status";
import { EmptyState, Notice } from "@/components/app/empty-state";
import { UrlSearch } from "@/components/app/url-controls";
import { hasPermission } from "@/lib/auth/permissions";
import { formatDateIST } from "@/lib/time";
import { TemplateFilters } from "./template-filters";

export const metadata = { title: "Templates" };

const APPROVAL_TONE = { APPROVED: "success", PENDING: "warning", DRAFT: "muted", REJECTED: "danger", DISABLED: "muted" } as const;

export default async function TemplatesPage({ searchParams }: PageProps<"/templates">) {
  const user = await requirePageUser("templates:read");
  const sp = await searchParams;
  const channel = sp.channel === "EMAIL" || sp.channel === "WHATSAPP" ? sp.channel : undefined;
  const categoryId = typeof sp.categoryId === "string" ? sp.categoryId : undefined;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const [templates, categories] = await Promise.all([listTemplates({ channel, categoryId, q }), listCategories()]);

  return (
    <div className="animate-in-fade">
      <PageHeader
        title="Template library"
        description="Local registry of provider templates, mapped to the categories allowed to use them. Every content change creates a new immutable version."
        actions={
          hasPermission(user.role, "templates:write") && (
            <Button asChild>
              <Link href="/templates/new">
                <PlusIcon /> New template
              </Link>
            </Button>
          )
        }
      />
      <Notice tone="info" className="mb-4" title="How provider templates are linked">
        WhatsApp templates must already be approved by Meta in DoubleTick — register the exact template name and language here (DoubleTick’s API does not create templates). Email content is hosted by this dashboard and handed to Zoho Marketing Automation as the campaign content URL at send time.
      </Notice>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <UrlSearch placeholder="Search name or provider ID" />
        <TemplateFilters categories={categories.map((c) => ({ id: c.id, name: c.name }))} />
      </div>
      {templates.length ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Template</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Provider ID</TableHead>
                  <TableHead>Approval</TableHead>
                  <TableHead className="text-right">Version</TableHead>
                  <TableHead>Categories</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((t) => {
                  const errors = t.issues.filter((i) => i.level === "error").length;
                  return (
                    <TableRow key={t.id}>
                      <TableCell>
                        <Link href={`/templates/${t.id}`} className="font-medium hover:underline">
                          {t.name}
                        </Link>
                        <p className="max-w-xs truncate text-xs text-muted-foreground">{t.channel === "EMAIL" ? t.subject : t.body}</p>
                      </TableCell>
                      <TableCell>
                        <ChannelBadge channel={t.channel} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {t.providerTemplateId ?? <span className="text-muted-foreground">hosted</span>}
                        {t.language && <span className="ml-1 text-muted-foreground">({t.language})</span>}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <Pill tone={APPROVAL_TONE[t.approvalStatus]}>{t.approvalStatus.toLowerCase()}</Pill>
                          {errors > 0 && (
                            <span title={`${errors} validation error(s)`} className="text-destructive">
                              <AlertTriangleIcon className="size-3.5" />
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="tabular text-right">v{t.currentVersion}</TableCell>
                      <TableCell>
                        <div className="flex max-w-xs flex-wrap gap-1">
                          {t.categories.length ? t.categories.map((c) => <CategoryChip key={c.id} name={c.name} color={c.color} />) : <span className="text-xs text-muted-foreground">Not mapped</span>}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateIST(t.updatedAt)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : (
        <EmptyState icon={FileTextIcon} title="No templates found" description="Register your DoubleTick-approved WhatsApp templates and email content, then map them to categories." />
      )}
    </div>
  );
}
