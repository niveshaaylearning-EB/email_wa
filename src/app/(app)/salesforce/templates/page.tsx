import Link from "next/link";
import { LayoutTemplateIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { listAssets } from "@/lib/services/salesforce/queries";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/empty-state";
import { UrlPagination, UrlSearch } from "@/components/app/url-controls";
import { Pill } from "@/components/app/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SimulatedBadge, fmt, formatBytes } from "@/components/salesforce/status";

export const metadata = { title: "Template Archive" };

export default async function TemplatesPage({ searchParams }: PageProps<"/salesforce/templates">) {
  await requirePageUser("archive:read");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const type = typeof sp.type === "string" ? sp.type : undefined;
  const { total, rows, types } = await listAssets({ q, type, page, pageSize: 50 });

  return (
    <div className="animate-in-fade">
      <PageHeader title="Template Archive" description="Content Builder assets with their original content stored unaltered (encrypted, hashed). Previews are sanitised and sandboxed — archived scripts never run." />
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <UrlSearch placeholder="Search name, subject or asset ID" />
        <div className="flex flex-wrap gap-1">
          <Link href="/salesforce/templates" className={`rounded-md border px-2 py-0.5 text-xs ${!type ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}>All ({fmt.format(types.reduce((a, t) => a + t.count, 0))})</Link>
          {types.map((t) => (
            <Link key={t.type ?? "none"} href={`/salesforce/templates?type=${encodeURIComponent(t.type ?? "")}`} className={`rounded-md border px-2 py-0.5 text-xs ${type === t.type ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}>
              {t.type ?? "unknown"} ({t.count})
            </Link>
          ))}
        </div>
      </div>
      {rows.length ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Asset</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Folder</TableHead>
                  <TableHead>Subject</TableHead>
                  <TableHead>Modified (source)</TableHead>
                  <TableHead className="text-right">Content</TableHead>
                  <TableHead className="text-right">External refs</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="max-w-[280px]">
                      <Link href={`/salesforce/templates/${a.id}`} className="block truncate font-medium hover:underline">{a.name}</Link>
                      <p className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">#{a.assetId} · MID {a.mid}{a.isSimulated && <SimulatedBadge />}</p>
                    </TableCell>
                    <TableCell><Pill tone="muted">{a.assetType ?? "—"}</Pill></TableCell>
                    <TableCell className="max-w-[200px] truncate text-xs text-muted-foreground">{a.categoryPath ?? "—"}</TableCell>
                    <TableCell className="max-w-[260px] truncate text-sm">{a.subject ?? "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{a.modifiedDate ?? "—"}</TableCell>
                    <TableCell className="tabular text-right text-xs">{a.contentBytes ? formatBytes(a.contentBytes) : "—"}</TableCell>
                    <TableCell className="tabular text-right">{(a.references as unknown[]).length || "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-3"><UrlPagination total={total} page={page} pageSize={50} /></div>
        </div>
      ) : (
        <EmptyState icon={LayoutTemplateIcon} title="No content archived" description="Run a backup with “Content Builder templates & assets” selected." />
      )}
    </div>
  );
}
