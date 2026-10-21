import type { SoapFilter } from "@/lib/salesforce/soap";

export interface SoapRequestSpec {
  objectType: string;
  properties: string[];
  filter?: SoapFilter;
  queryAllAccounts?: boolean;
  /** e.g. the DE CustomerKey a DataExtensionField request belongs to */
  tag?: string;
}

/** Stored in salesforce_backup_datasets.params (frozen when the dataset is sealed). */
export interface DatasetParams {
  channel: "soap" | "rest" | "upload" | "files";
  /** CONTENT_FILES: the published URLs to download, in order (one "page" per file). */
  files?: { url: string; assetId?: string | null }[];
  allowedHosts?: string[];
  requests?: SoapRequestSpec[];
  rest?: { path: string; pageSize: number; pageSizeParam: string; extraQuery?: Record<string, string> };
  /** Max records per SOAP page for this source (2,500 for SFMC). Used by page-size checks. */
  pageLimit: number;
  droppedProperties?: Record<string, string[]>;
  // DE rows
  dataExtensionId?: string;
  primaryKeyFields?: string[];
  schema?: { name: string; fieldType: string | null; isPrimaryKey: boolean | null; isRequired: boolean | null; maxLength: string | null }[];
  // tracking
  jobId?: string;
  sendDate?: string | null;
  window?: { from?: string; to?: string };
  // lookups resolved at planning time
  folderPaths?: Record<string, string>;
  categoryPaths?: Record<string, string>;
  // uploads
  upload?: { fileName: string; sha256: string; bytes: number; storageKey: string; evidenceNote?: string; snapshotDate?: string | null; label: "CURRENT_STATE" | "HISTORICAL_EVIDENCED" };
  sourceTimezoneOffset?: string;
}

export interface DatasetCheckpoint {
  reqIndex?: number;
  requestId?: string | null;
  nextPage?: number;
  restPage?: number;
  /** Pages fetched per SOAP request index (for per-request page-size verification). */
  requestPages?: Record<string, { pages: number; lastStatus: string | null }>;
  restarts?: number;
  stepRetries?: number;
  restTotal?: number | null;
}

export interface VerificationCheck {
  key: string;
  label: string;
  status: "pass" | "fail" | "warn" | "info" | "na";
  detail: string;
}
