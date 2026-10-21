/**
 * READ-ONLY GUARANTEE. Every HTTP request the archive makes to Salesforce passes through
 * assertReadOnlyRequest() before it leaves the process. Anything that is not on this
 * allow-list is rejected locally and never reaches Salesforce.
 *
 *   • Auth:  POST {auth}/v2/token (client_credentials) and GET {auth}/v2/userinfo
 *   • SOAP:  POST {soap}/Service.asmx with SOAPAction "Retrieve" and a RetrieveRequestMsg body only
 *   • REST:  GET on allow-listed read resources, plus POST to the Content Builder asset *query*
 *            endpoint, which is a documented search (it reads, it does not write).
 *   • Files: unauthenticated GET of published content files (images/PDFs) on their public URLs.
 *
 * There is intentionally no code path for Create/Update/Delete/Perform/Schedule/Execute,
 * Data Extension writes, journey/automation start/stop, or any send.
 */
import { SfmcError } from "./errors";

export const READ_SCOPES_RECOMMENDED = [
  "data_extensions_read",
  "email_read",
  "tracking_events_read",
  "list_and_subscribers_read",
  "journeys_read",
  "automations_read",
  "saved_content_read",
  "documents_and_images_read",
  "accounts_read",
] as const;

const REST_GET_ALLOW: RegExp[] = [
  // Data Extension rows (read). Used because SOAP DataExtensionObject retrieve can be denied
  // ("API Permission Failed") for installed-package users that hold data_extensions_read.
  /^\/data\/v1\/customobjectdata\/key\/[^/]+\/rowset\/?$/,
  /^\/interaction\/v1\/interactions\/?$/,
  /^\/interaction\/v1\/interactions\/[A-Za-z0-9-]+\/?$/,
  /^\/asset\/v1\/content\/assets\/?$/,
  /^\/asset\/v1\/content\/assets\/\d+\/?$/,
  /^\/asset\/v1\/content\/categories\/?$/,
  /^\/asset\/v1\/content\/categories\/\d+\/?$/,
  /^\/platform\/v1\/endpoints\/?$/,
];
const REST_POST_ALLOW: RegExp[] = [/^\/asset\/v1\/content\/assets\/query\/?$/];

const SOAP_FORBIDDEN_ACTIONS = /<(\w+:)?(Create|Update|Delete|Perform|Configure|Execute|Schedule|Extract|Upsert)Request(Msg)?[\s>]/;

export type GuardedRequest =
  | { channel: "auth"; method: string; path: string }
  | { channel: "soap"; method: string; soapAction: string; body: string }
  | { channel: "rest"; method: string; path: string }
  | { channel: "file"; method: string; url: string };

export function assertReadOnlyRequest(req: GuardedRequest): void {
  const method = req.method.toUpperCase();
  if (req.channel === "auth") {
    if (method === "POST" && /^\/v2\/token\/?$/.test(req.path)) return;
    if (method === "GET" && /^\/v2\/userinfo\/?$/.test(req.path)) return;
    throw new SfmcError("readonly", `Blocked non-read auth request ${method} ${req.path}`);
  }
  if (req.channel === "soap") {
    if (method !== "POST") throw new SfmcError("readonly", `Blocked SOAP ${method}`);
    if (req.soapAction !== "Retrieve") throw new SfmcError("readonly", `Blocked SOAP action "${req.soapAction}" — only Retrieve is permitted`);
    if (!/<RetrieveRequestMsg[\s>]/.test(req.body) || SOAP_FORBIDDEN_ACTIONS.test(req.body)) {
      throw new SfmcError("readonly", "Blocked SOAP body that is not a pure RetrieveRequestMsg");
    }
    return;
  }
  if (req.channel === "file") {
    if (method !== "GET" || !/^https:\/\//i.test(req.url)) throw new SfmcError("readonly", `Blocked file request ${method} ${req.url}`);
    return;
  }
  const path = req.path.split("?")[0];
  if (method === "GET" && REST_GET_ALLOW.some((r) => r.test(path))) return;
  if (method === "POST" && REST_POST_ALLOW.some((r) => r.test(path))) return;
  throw new SfmcError("readonly", `Blocked REST ${method} ${path} — not on the read-only allow-list`);
}
