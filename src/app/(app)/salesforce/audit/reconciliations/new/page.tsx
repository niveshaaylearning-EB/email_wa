import Link from "next/link";
import { requirePageUser } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { audienceCandidates } from "@/lib/services/salesforce/queries";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/app/empty-state";
import type { DatasetParams } from "@/lib/services/salesforce/types";
import { ReconciliationForm } from "./reconciliation-form";

export const metadata = { title: "New reconciliation" };

export default async function NewReconciliationPage({ searchParams }: PageProps<"/salesforce/audit/reconciliations/new">) {
  await requirePageUser("archive:reconcile");
  const sp = await searchParams;
  const [candidates, jobs, sentDatasets] = await Promise.all([
    audienceCandidates(),
    prisma.salesforceEmailJob.findMany({ orderBy: { sendDate: "desc" }, take: 2000, select: { jobId: true, mid: true, emailName: true, sendDate: true, sentDate: true } }),
    prisma.salesforceBackupDataset.findMany({ where: { kind: "TRACKING_SENT", status: "EXTRACTED", supersededById: null }, select: { sourceKey: true, mid: true } }),
  ]);
  const tracked = new Set(sentDatasets.map((d) => `${d.mid}:${d.sourceKey}`));
  if (!jobs.length) {
    return (
      <div className="animate-in-fade">
        <PageHeader title="New reconciliation" />
        <EmptyState title="No archived send jobs" description="Back up send jobs and recipient-level tracking first." action={<Link className="text-sm text-primary hover:underline" href="/salesforce/backups">Backup Center</Link>} />
      </div>
    );
  }
  return (
    <div className="animate-in-fade">
      <PageHeader
        eyebrow={<Link href="/salesforce/audit" className="hover:underline">SEBI Audit Center</Link>}
        title="New reconciliation"
        description="Compare an audience against recipient-level send tracking. Every audience row is classified using the strongest available evidence; anything without evidence stays UNRESOLVED."
      />
      <ReconciliationForm
        defaults={{ mid: typeof sp.mid === "string" ? sp.mid : undefined, jobId: typeof sp.jobId === "string" ? sp.jobId : undefined }}
        jobs={jobs.map((j) => ({ jobId: j.jobId, mid: j.mid, emailName: j.emailName, sendDate: (j.sentDate ?? j.sendDate)?.toISOString() ?? null, sentTracked: tracked.has(`${j.mid}:${j.jobId}`) }))}
        audiences={candidates.map((c) => {
          const p = c.params as unknown as DatasetParams;
          return { id: c.id, kind: c.kind, label: c.label, mid: c.mid, records: c.recordsExtracted, extractedAt: c.finishedAt?.toISOString() ?? null, fields: p.schema?.map((f) => f.name) ?? [], current: !c.supersededById, historicalUpload: p.upload?.label === "HISTORICAL_EVIDENCED", simulated: c.isSimulated };
        })}
      />
    </div>
  );
}
