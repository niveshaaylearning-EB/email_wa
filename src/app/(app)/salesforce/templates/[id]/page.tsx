import Link from "next/link";
import { ShieldCheckIcon } from "lucide-react";
import { requirePageUser } from "@/lib/auth/guard";
import { prisma } from "@/lib/db";
import { notFound } from "@/lib/errors";
import { PageHeader } from "@/components/app/page-header";
import { Notice } from "@/components/app/empty-state";
import { Pill } from "@/components/app/status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SimulatedBadge, formatBytes } from "@/components/salesforce/status";
import { PreviewFrame } from "@/components/salesforce/preview-frame";

export const metadata = { title: "Archived template" };

export default async function TemplatePage({ params }: PageProps<"/salesforce/templates/[id]">) {
  await requirePageUser("archive:read");
  const { id } = await params;
  const a = await prisma.salesforceAsset.findUnique({ where: { id } });
  if (!a) throw notFound("Archived template");
  const refs = a.references as { kind: string; url: string; status: string }[];
  const jobs = await prisma.salesforceEmailJob.findMany({ where: { mid: a.mid, emailId: a.assetId }, orderBy: { sendDate: "desc" }, take: 20, select: { jobId: true, mid: true, emailName: true, sendDate: true } });

  return (
    <div className="animate-in-fade space-y-5">
      <PageHeader
        eyebrow={<Link href="/salesforce/templates" className="hover:underline">Template Archive</Link>}
        title={<span className="inline-flex flex-wrap items-center gap-2">{a.name}{a.isSimulated && <SimulatedBadge />}</span>}
        description={<>Asset <span className="font-mono">#{a.assetId}</span> · {a.assetType} · {a.categoryPath ?? "—"} · modified {a.modifiedDate ?? "—"}</>}
      />
      <Notice tone="success" icon={ShieldCheckIcon} title="Safe preview">
        Scripts, event handlers and embedded frames are removed, and the preview runs in a sandboxed frame with a script-free Content-Security-Policy. Images are shown from the archive by default (Live images loads them from Salesforce). The original content is stored unaltered (SHA-256 <span className="font-mono text-xs">{a.contentSha256?.slice(0, 16) ?? "—"}…</span>).
      </Notice>
      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        {a.contentStorageKey ? <PreviewFrame src={`/api/v1/salesforce/assets/${a.id}/preview`} /> : <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">No HTML/text content was returned for this asset type.</CardContent></Card>}
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Email metadata</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-1.5 text-sm">
                <div><dt className="text-muted-foreground">Subject</dt><dd>{a.subject ?? "—"}</dd></div>
                <div><dt className="text-muted-foreground">Preheader</dt><dd>{a.preheader ?? "—"}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">Content size</dt><dd>{a.contentBytes ? formatBytes(a.contentBytes) : "—"}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">CustomerKey</dt><dd className="font-mono text-xs">{a.customerKey ?? "—"}</dd></div>
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">External references ({refs.length})</CardTitle></CardHeader>
            <CardContent>
              {refs.length ? (
                <ul className="max-h-72 space-y-1.5 overflow-auto text-xs">
                  {refs.map((r) => (
                    <li key={`${r.kind}${r.url}`} className="flex items-start gap-2">
                      <Pill tone={r.status === "unresolved" ? "warning" : "muted"}>{r.kind.replace("_", " ")}</Pill>
                      <span className="break-all font-mono">{r.url}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">None detected.</p>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">External images are not copied into the archive; they may disappear when the Salesforce account closes. AMPscript content-block references are listed as unresolved.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">Sends using this email</CardTitle></CardHeader>
            <CardContent>
              {jobs.length ? (
                <ul className="space-y-1 text-sm">{jobs.map((j) => <li key={j.jobId}><Link className="font-mono text-xs text-primary hover:underline" href={`/salesforce/campaigns/${j.mid}/${j.jobId}`}>{j.jobId}</Link> <span className="text-xs text-muted-foreground">{j.sendDate?.toISOString().slice(0, 10)}</span></li>)}</ul>
              ) : (
                <p className="text-sm text-muted-foreground">No archived send jobs reference this asset ID.</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
