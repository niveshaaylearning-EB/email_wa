"use client";

import { FileSearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { CheckList, DatasetStatusBadge, SimulatedBadge, VerificationBadge, fmt, formatBytes, DATASET_KIND_LABELS } from "./status";
import { ExportButton } from "./export-button";
import { ActionButton } from "./action-button";

export interface DatasetDrawerData {
  id: string;
  kind: string;
  label: string;
  mid: string;
  objectType: string;
  sourceKey: string | null;
  status: string;
  verificationStatus: string;
  attempt: number;
  pagesFetched: number;
  recordsExtracted: number;
  sourceCount: number | null;
  sourceCountMethod: string | null;
  apiCalls: number;
  retries: number;
  bytesStored: number;
  startedAt: string | null;
  finishedAt: string | null;
  sealedAt: string | null;
  verifiedAt: string | null;
  errorMessage: string | null;
  isSimulated: boolean;
  supersededById: string | null;
  checks: { key: string; label: string; status: string; detail: string }[];
  droppedProperties: Record<string, string[]>;
  properties: string[];
}

const ROW_EXPORT = new Set(["DE_ROWS", "AUDIENCE_UPLOAD", "TRACKING_SENT", "TRACKING_OPEN", "TRACKING_CLICK", "TRACKING_BOUNCE", "TRACKING_UNSUB", "TRACKING_NOTSENT"]);

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  );
}

export function DatasetDrawer({ d, canExport, canReconcile }: { d: DatasetDrawerData; canExport: boolean; canReconcile: boolean }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Dataset details">
          <FileSearchIcon />
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="pr-6">{d.label}</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2">
            <DatasetStatusBadge status={d.status} />
            <VerificationBadge status={d.verificationStatus} />
            {d.isSimulated && <SimulatedBadge />}
            {d.supersededById && <span className="text-xs">superseded by a newer extraction</span>}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-5 px-4 pb-6">
          <dl className="divide-y rounded-lg border px-3">
            <Row k="Dataset" v={<span className="font-mono text-xs">{d.id}</span>} />
            <Row k="Type" v={DATASET_KIND_LABELS[d.kind] ?? d.kind} />
            <Row k="Source object" v={<span className="font-mono text-xs">{d.objectType}</span>} />
            <Row k="Business unit (MID)" v={<span className="font-mono">{d.mid}</span>} />
            <Row k="Attempt" v={d.attempt} />
            <Row k="Pages · records" v={`${fmt.format(d.pagesFetched)} · ${fmt.format(d.recordsExtracted)}`} />
            <Row k="Independent count" v={d.sourceCount !== null ? `${fmt.format(d.sourceCount)}` : "not available"} />
            <Row k="API calls · retries" v={`${fmt.format(d.apiCalls)} · ${fmt.format(d.retries)}`} />
            <Row k="Raw payload stored" v={formatBytes(d.bytesStored)} />
            <Row k="Extraction window" v={<span className="text-xs">{d.startedAt?.replace("T", " ").slice(0, 19) ?? "—"} → {d.finishedAt?.replace("T", " ").slice(0, 19) ?? "—"} UTC</span>} />
            <Row k="Sealed (immutable)" v={d.sealedAt ? d.sealedAt.replace("T", " ").slice(0, 19) + " UTC" : "not yet"} />
          </dl>
          {d.errorMessage && <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">{d.errorMessage}</p>}
          <div>
            <p className="mb-2 text-sm font-semibold">Verification checks</p>
            <CheckList checks={d.checks} />
          </div>
          {Object.keys(d.droppedProperties).length > 0 && (
            <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-xs">
              <p className="mb-1 font-medium">Properties rejected by this account (not archived)</p>
              {Object.entries(d.droppedProperties).map(([o, ps]) => (
                <p key={o} className="font-mono">
                  {o}: {ps.join(", ")}
                </p>
              ))}
            </div>
          )}
          {d.properties.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer font-medium">Requested properties ({d.properties.length})</summary>
              <p className="mt-1 font-mono leading-relaxed text-muted-foreground">{d.properties.join(", ")}</p>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            {canExport && ROW_EXPORT.has(d.kind) && d.status === "EXTRACTED" && <ExportButton spec={{ type: "dataset_rows", datasetId: d.id }} label="Export records" />}
            {canReconcile && d.sealedAt && <ActionButton path={`/api/v1/salesforce/datasets/${d.id}/reverify`} label="Re-verify" icon="refresh" />}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
