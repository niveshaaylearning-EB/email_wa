import "server-only";
import type { SalesforceBackupDataset } from "@prisma/client";
import type { DatasetDrawerData } from "@/components/salesforce/dataset-drawer";
import type { DatasetParams, VerificationCheck } from "./types";

/** Browser-safe projection of a dataset for the detail drawer. */
export function datasetDrawerData(d: SalesforceBackupDataset): DatasetDrawerData {
  const params = d.params as unknown as DatasetParams;
  return {
    id: d.id,
    kind: d.kind,
    label: d.label,
    mid: d.mid,
    objectType: d.objectType,
    sourceKey: d.sourceKey,
    status: d.status,
    verificationStatus: d.verificationStatus,
    attempt: d.attempt,
    pagesFetched: d.pagesFetched,
    recordsExtracted: d.recordsExtracted,
    sourceCount: d.sourceCount,
    sourceCountMethod: d.sourceCountMethod,
    apiCalls: d.apiCalls,
    retries: d.retries,
    bytesStored: Number(d.bytesStored),
    startedAt: d.startedAt?.toISOString() ?? null,
    finishedAt: d.finishedAt?.toISOString() ?? null,
    sealedAt: d.sealedAt?.toISOString() ?? null,
    verifiedAt: d.verifiedAt?.toISOString() ?? null,
    errorMessage: d.errorMessage,
    isSimulated: d.isSimulated,
    supersededById: d.supersededById,
    checks: ((d.verificationDetails as { checks?: VerificationCheck[] }).checks ?? []).map((c) => ({ ...c })),
    droppedProperties: params.droppedProperties ?? {},
    properties: params.requests?.[0]?.properties ?? params.schema?.map((f) => f.name) ?? [],
  };
}
