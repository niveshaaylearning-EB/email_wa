/**
 * Error taxonomy for Salesforce Marketing Cloud (SFMC) calls. The kind drives retry and
 * dataset status decisions:
 *   auth        → refresh the token once, then fail (credentials / installed package problem)
 *   permission  → dataset NOT_ACCESSIBLE (scope or BU permission missing). Never retried.
 *   rate_limit  → retried with backoff (HTTP 429 or SFMC throttling faults)
 *   server      → retried with backoff (5xx)
 *   network     → retried with backoff (all archive calls are reads, so retrying is safe)
 *   continuation→ the RequestID continuation can no longer be used; the dataset restarts
 *   request     → malformed request / unknown property; not retried
 *   readonly    → blocked locally by the read-only guard; a bug, never sent to Salesforce
 */
export type SfmcErrorKind = "auth" | "permission" | "rate_limit" | "server" | "network" | "continuation" | "request" | "readonly";

export class SfmcError extends Error {
  constructor(
    public kind: SfmcErrorKind,
    message: string,
    public details: { httpStatus?: number; code?: string; objectType?: string } = {},
  ) {
    super(message);
    this.name = "SfmcError";
  }

  get retryable() {
    return this.kind === "rate_limit" || this.kind === "server" || this.kind === "network";
  }
}

export function isSfmcError(err: unknown): err is SfmcError {
  return err instanceof SfmcError;
}

const PERMISSION_RE = /(insufficient privileges|not authorized|unauthorized to|permission|access denied|does not have access|scope|forbidden)/i;
const AUTH_RE = /(login failed|token (is )?(expired|invalid)|invalid[_ ]token|authentication|security requirements)/i;
const THROTTLE_RE = /(too many|throttl|rate limit|concurrent|maximum number of (simultaneous|concurrent))/i;
const CONTINUATION_RE = /(continue ?request|request ?id).*(invalid|expired|not found|no longer)|(invalid|expired).*(continue ?request|request ?id)/i;

/** Classify an SFMC message (SOAP fault string, OverallStatus "Error: …", REST message). */
export function classifyMessage(message: string, httpStatus?: number): SfmcErrorKind {
  if (httpStatus === 429 || THROTTLE_RE.test(message)) return "rate_limit";
  if (CONTINUATION_RE.test(message)) return "continuation";
  if (httpStatus === 401 || AUTH_RE.test(message)) return "auth";
  if (httpStatus === 403 || PERMISSION_RE.test(message)) return "permission";
  if (httpStatus && httpStatus >= 500) return "server";
  return "request";
}
