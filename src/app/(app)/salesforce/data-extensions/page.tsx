import Link from "next/link";
import { Table2Icon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { listDataExtensions } from "@/lib/services/salesforce/queries";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/empty-state";
import { UrlPagination, UrlSearch } from "@/components/app/url-controls";
import { Pill } from "@/components/app/status";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DatasetStatusBadge, SimulatedBadge, VerificationBadge, fmt } from "@/components/salesforce/status";
import { formatIST } from "@/lib/time";

export const metadata = { title: "Data Extensions" };

export default async function DataExtensionsPage({ searchParams }: PageProps<"/salesforce/data-extensions">) {
  await requirePageUser("archive:read");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const { total, rows } = await listDataExtensions({ q, page, pageSize: 50 });

  return (
    <div className="animate-in-fade">
      <PageHeader title="Data Extensions" description="Every Data Extension visible to the API user, with its schema and archived row snapshots. A snapshot reflects the DE at extraction time — not necessarily its contents at any past send." />
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <UrlSearch placeholder="Search name, CustomerKey or folder" />
        <p className="text-xs text-muted-foreground">{fmt.format(total)} Data Extension(s)</p>
      </div>
      {rows.length ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Folder</TableHead>
                  <TableHead>MID</TableHead>
                  <TableHead className="text-right">Fields</TableHead>
                  <TableHead className="text-right">Archived rows</TableHead>
                  <TableHead>Verification</TableHead>
                  <TableHead>Snapshot (IST)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="max-w-[320px]">
                      <Link href={`/salesforce/data-extensions/${r.id}`} className="block truncate font-medium hover:underline">
                        {r.name}
                      </Link>
                      <p className="flex items-center gap-1.5 truncate font-mono text-xs text-muted-foreground">
                        {r.customerKey}
                        {r.isSendable && <Pill tone="brand" className="py-0 text-[10px]">sendable</Pill>}
                        {r.isSimulated && <SimulatedBadge />}
                      </p>
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate text-xs text-muted-foreground" title={r.folderPath ?? ""}>{r.folderPath ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{r.mid}</TableCell>
                    <TableCell className="tabular text-right">{r._count.fields}</TableCell>
                    <TableCell className="tabular text-right">
                      {r.rows ? fmt.format(r.rows.recordsExtracted) : r.lastAttempt ? <DatasetStatusBadge status={r.lastAttempt.status} /> : <span className="text-muted-foreground">not extracted</span>}
                      {r.attestedCount !== null && <p className="text-[11px] text-muted-foreground">UI count {fmt.format(r.attestedCount)}</p>}
                    </TableCell>
                    <TableCell>{r.rows ? <VerificationBadge status={r.rows.verificationStatus} /> : "—"}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{r.rows?.finishedAt ? formatIST(r.rows.finishedAt) : "—"}</TableCell>
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
        <EmptyState icon={Table2Icon} title={q ? "No Data Extensions match" : "No Data Extensions archived yet"} description="Run a backup with “Data Extension metadata & schemas” selected." />
      )}
    </div>
  );
}
