import Link from "next/link";
import { ActivityIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { queryAudit } from "@/lib/services/users";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/empty-state";
import { UrlPagination, UrlSearch } from "@/components/app/url-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Pill } from "@/components/app/status";
import { formatIST } from "@/lib/time";
import { ActivityFilters } from "./activity-filters";
import { MetadataCell } from "./metadata-cell";

export const metadata = { title: "Activity logs" };

const TONE = (action: string) =>
  /failed|rejected|cancel|denied|auto_paused|lifted/.test(action) ? "danger" : /approved|completed|connected|created|login$/.test(action) ? "success" : /submitted|paused|deferred|updated|tested/.test(action) ? "warning" : "neutral";

export default async function ActivityPage({ searchParams }: PageProps<"/activity">) {
  await requirePageUser("audit:read");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const entityType = typeof sp.entityType === "string" ? sp.entityType : undefined;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const { total, rows } = await queryAudit({ q, entityType, page, pageSize: 50 });
  return (
    <div className="animate-in-fade">
      <PageHeader
        title="Activity logs"
        description="Append-only audit trail (enforced by the database). Personal data in metadata is masked. Retained per the configured policy (minimum 5 years for SEBI RA records)."
      />
      <div className="mb-3 flex flex-col gap-2 sm:flex-row">
        <UrlSearch placeholder="Search action, user or entity ID" />
        <ActivityFilters />
      </div>
      {rows.length ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Time (IST)</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Entity</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id} className="align-top">
                    <TableCell className="tabular whitespace-nowrap text-xs text-muted-foreground">{formatIST(r.createdAt, "dd MMM yyyy, hh:mm:ss a")}</TableCell>
                    <TableCell>
                      <Pill tone={TONE(r.action)}>{r.action}</Pill>
                    </TableCell>
                    <TableCell className="text-sm">{r.actorEmail}</TableCell>
                    <TableCell className="text-xs">
                      <span className="text-muted-foreground">{r.entityType}</span>
                      {r.campaignId ? (
                        <Link href={`/campaigns/${r.campaignId}`} className="ml-1 font-mono hover:underline">
                          {r.entityId?.slice(0, 10)}
                        </Link>
                      ) : (
                        r.entityId && <span className="ml-1 font-mono">{r.entityId.slice(0, 12)}</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-md">
                      <MetadataCell value={r.metadata as Record<string, unknown>} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="border-t px-3">
            <UrlPagination total={total} page={page} pageSize={50} />
          </div>
        </div>
      ) : (
        <EmptyState icon={ActivityIcon} title="No activity found" />
      )}
    </div>
  );
}
