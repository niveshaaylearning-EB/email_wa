/**
 * SFMC SOAP API codec — RetrieveRequestMsg only (see readonly.ts).
 *
 * Retrieve semantics (official "Retrieve More than 2500 Records Using the ContinueRequest
 * Property" guide): each call returns at most 2,500 objects; OverallStatus
 * "MoreDataAvailable" means another page exists and is fetched by sending a RetrieveRequest
 * whose ContinueRequest is the previous RequestID. Each continuation can be consumed once.
 *
 * Values are parsed as raw strings (parseTagValue=false) so leading zeros, long numeric IDs
 * and timestamps are preserved exactly as returned.
 */
import { XMLParser } from "fast-xml-parser";
import { SfmcError, classifyMessage } from "./errors";

export const SOAP_PAGE_LIMIT = 2500;

export type SoapFilter =
  | { property: string; operator: "equals" | "notEquals" | "greaterThan" | "lessThan" | "greaterThanOrEqual" | "lessThanOrEqual" | "isNull" | "isNotNull" | "IN" | "like"; values?: string[] }
  | { property: string; operator: "between" | "greaterThan" | "lessThan" | "greaterThanOrEqual" | "lessThanOrEqual" | "equals"; dateValues: string[] }
  | { and: [SoapFilter, SoapFilter] }
  | { or: [SoapFilter, SoapFilter] };

export interface RetrieveParams {
  objectType: string;
  properties: string[];
  filter?: SoapFilter;
  /** Enterprise-level retrieve across child BUs (e.g. BusinessUnit discovery). */
  queryAllAccounts?: boolean;
  /** Target business unit(s) for the retrieve. Usually the token is already BU-scoped. */
  clientIds?: string[];
}

export function xmlEscape(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function filterXml(f: SoapFilter, tag: string): string {
  if ("and" in f || "or" in f) {
    const [l, r] = "and" in f ? f.and : f.or;
    return `<${tag} xsi:type="ComplexFilterPart">${filterXml(l, "LeftOperand")}<LogicalOperator>${"and" in f ? "AND" : "OR"}</LogicalOperator>${filterXml(r, "RightOperand")}</${tag}>`;
  }
  const values =
    "dateValues" in f ? f.dateValues.map((d) => `<DateValue>${xmlEscape(d)}</DateValue>`).join("") : (f.values ?? []).map((v) => `<Value>${xmlEscape(v)}</Value>`).join("");
  return `<${tag} xsi:type="SimpleFilterPart"><Property>${xmlEscape(f.property)}</Property><SimpleOperator>${f.operator}</SimpleOperator>${values}</${tag}>`;
}

function envelope(soapUrl: string, token: string, inner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">` +
    `<s:Header><a:Action s:mustUnderstand="1">Retrieve</a:Action><a:To s:mustUnderstand="1">${xmlEscape(soapUrl)}</a:To><fueloauth xmlns="http://exacttarget.com">${xmlEscape(token)}</fueloauth></s:Header>` +
    `<s:Body><RetrieveRequestMsg xmlns="http://exacttarget.com/wsdl/partnerAPI">${inner}</RetrieveRequestMsg></s:Body></s:Envelope>`
  );
}

export function buildRetrieveEnvelope(soapUrl: string, token: string, p: RetrieveParams): string {
  const parts = [
    p.clientIds?.length ? `<ClientIDs>${p.clientIds.map((id) => `<ClientID>${xmlEscape(id)}</ClientID>`).join("")}</ClientIDs>` : "",
    `<ObjectType>${xmlEscape(p.objectType)}</ObjectType>`,
    ...p.properties.map((prop) => `<Properties>${xmlEscape(prop)}</Properties>`),
    p.filter ? filterXml(p.filter, "Filter") : "",
    p.queryAllAccounts ? `<QueryAllAccounts>true</QueryAllAccounts>` : "",
  ];
  return envelope(soapUrl, token, `<RetrieveRequest>${parts.join("")}</RetrieveRequest>`);
}

export function buildContinueEnvelope(soapUrl: string, token: string, requestId: string): string {
  return envelope(soapUrl, token, `<RetrieveRequest><ContinueRequest>${xmlEscape(requestId)}</ContinueRequest></RetrieveRequest>`);
}

// ─── Response parsing ──────────────────────────────────────────────────

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false, // keep every value as the exact string returned
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
  isArray: (name, jpath) => name === "Results" || name === "Property" || String(jpath).endsWith(".ClientIDs.ClientID"),
});

export type SoapObject = Record<string, unknown>;

export interface RetrievePage {
  overallStatus: string;
  requestId: string | null;
  results: SoapObject[];
  moreData: boolean;
}

function textOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && (v as Record<string, unknown>)["@nil"] === "true") return null;
  if (typeof v === "object" && "#text" in (v as Record<string, unknown>)) return String((v as Record<string, unknown>)["#text"]);
  if (typeof v === "object" && Object.keys(v as object).length === 0) return "";
  return String(v);
}

/** Strip parser artefacts: attributes (except xsi:type) and wrap scalars as strings. */
export function normalizeSoapObject(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v !== "object") return String(v);
  if (Array.isArray(v)) return v.map(normalizeSoapObject);
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 0) return "";
  if (o["@nil"] === "true") return null;
  if ("#text" in o && keys.every((k) => k === "#text" || k.startsWith("@"))) return String(o["#text"]);
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k === "@type") out["@type"] = o[k];
    else if (!k.startsWith("@")) out[k] = normalizeSoapObject(o[k]);
  }
  return out;
}

export function parseRetrieveResponse(xml: string, httpStatus: number): RetrievePage {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new SfmcError(httpStatus >= 500 ? "server" : "request", `Unparseable SOAP response (HTTP ${httpStatus})`, { httpStatus });
  }
  const body = ((doc.Envelope as Record<string, unknown> | undefined)?.Body ?? {}) as Record<string, unknown>;
  const fault = body.Fault as Record<string, unknown> | undefined;
  if (fault) {
    const msg = textOf(fault.faultstring) ?? textOf((fault.Reason as Record<string, unknown> | undefined)?.Text) ?? "SOAP fault";
    const code = textOf(fault.faultcode) ?? undefined;
    throw new SfmcError(classifyMessage(msg, httpStatus), `SOAP fault: ${msg}`, { httpStatus, code });
  }
  const msg = body.RetrieveResponseMsg as Record<string, unknown> | undefined;
  if (!msg) throw new SfmcError(httpStatus >= 500 ? "server" : "request", `SOAP response without RetrieveResponseMsg (HTTP ${httpStatus})`, { httpStatus });
  const overallStatus = textOf(msg.OverallStatus) ?? "";
  const requestId = textOf(msg.RequestID);
  const results = ((msg.Results as unknown[]) ?? []).map((r) => normalizeSoapObject(r) as SoapObject);
  if (/^Error/i.test(overallStatus)) {
    throw new SfmcError(classifyMessage(overallStatus, httpStatus), `Retrieve failed: ${overallStatus}`, { httpStatus });
  }
  return { overallStatus, requestId, results, moreData: overallStatus === "MoreDataAvailable" };
}

/** DataExtensionObject rows come back as Properties.Property[{Name, Value}] → { name: value }. */
export function dataExtensionRowValues(obj: SoapObject): Record<string, string | null> {
  const props = ((obj.Properties as Record<string, unknown> | undefined)?.Property ?? []) as { Name?: unknown; Value?: unknown }[];
  const out: Record<string, string | null> = {};
  for (const p of props) {
    const name = textOf(p.Name);
    if (name === null) continue;
    out[name] = p.Value === undefined ? null : textOf(p.Value);
  }
  return out;
}

/** Read a (possibly nested, dot-separated) property as a string. */
export function prop(obj: SoapObject, path: string): string | null {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[part];
  }
  return textOf(cur);
}
