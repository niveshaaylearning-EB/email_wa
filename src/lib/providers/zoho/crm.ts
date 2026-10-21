/**
 * Zoho CRM v8 adapter (read-only).
 * Docs: https://www.zoho.com/crm/developer/docs/api/v8/get-records.html
 *       https://www.zoho.com/crm/developer/docs/api/v8/get-deleted-records.html
 *       https://www.zoho.com/crm/developer/docs/api/v8/api-limits.html
 *
 * - `fields` is mandatory (max 50); per_page max 200
 * - `page` is limited to 2000 records → we always paginate with `page_token`
 * - incremental: sort_by=Modified_Time asc + If-Modified-Since header (HTTP 304 = no changes)
 */
import "server-only";
import { zohoFetch } from "./oauth";
import { getDataCenter } from "./dc";
import { loadIntegration, recordProviderError, recordProviderSuccess } from "@/lib/services/integrations";
import { ProviderError, type CrmContact, type CrmDeletedPage, type CrmPage, type CrmProvider, type ConnectionTestResult } from "../types";
import { formatInTimeZone } from "date-fns-tz";

const BASE_FIELDS = [
  "First_Name",
  "Last_Name",
  "Full_Name",
  "Email",
  "Secondary_Email",
  "Phone",
  "Mobile",
  "Email_Opt_Out",
  "Modified_Time",
  "Owner",
  "Account_Name",
];

interface ZohoRecordsResponse {
  data?: Record<string, unknown>[];
  info?: { more_records?: boolean; next_page_token?: string | null; count?: number };
  code?: string;
  message?: string;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "object" && v && "name" in v) return String((v as { name: unknown }).name ?? "") || null;
  return String(v);
}

export function mapZohoContact(r: Record<string, unknown>, cfg: { statusField?: string; cityField?: string; extraFields: string[] }): CrmContact {
  const extra: Record<string, unknown> = {};
  for (const f of cfg.extraFields) if (f in r) extra[f] = r[f];
  if (r.Account_Name) extra.Account_Name = str(r.Account_Name);
  return {
    id: String(r.id),
    firstName: str(r.First_Name),
    lastName: str(r.Last_Name),
    fullName: str(r.Full_Name),
    email: str(r.Email),
    secondaryEmail: str(r.Secondary_Email),
    phone: str(r.Phone),
    mobile: str(r.Mobile),
    emailOptOut: r.Email_Opt_Out === true,
    modifiedTime: str(r.Modified_Time),
    owner: str(r.Owner),
    city: cfg.cityField ? str(r[cfg.cityField]) : null,
    status: cfg.statusField ? str(r[cfg.statusField]) : null,
    extra,
  };
}

export class ZohoCrmAdapter implements CrmProvider {
  readonly kind = "real" as const;

  private async ctx() {
    const { config, secrets } = await loadIntegration("ZOHO_CRM");
    const apiDomain = secrets.apiDomain || getDataCenter(config.dc).apiDomain;
    const fields = [...new Set([...BASE_FIELDS, config.statusField, config.cityField, ...config.extraFields].filter(Boolean))].slice(0, 50);
    return { config, apiDomain, fields };
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const t0 = Date.now();
    try {
      const { apiDomain } = await this.ctx();
      const res = await zohoFetch<ZohoRecordsResponse>("ZOHO_CRM", `${apiDomain}/crm/v8/Contacts?fields=Last_Name&per_page=1`);
      if (res.status === 204 || res.ok) {
        await recordProviderSuccess("ZOHO_CRM", { status: "CONNECTED", accountInfo: { apiDomain } });
        return { ok: true, message: "Connected to Zoho CRM (Contacts read access confirmed).", accountInfo: { apiDomain }, latencyMs: Date.now() - t0 };
      }
      const msg = res.json?.message ?? res.json?.code ?? `HTTP ${res.status}`;
      await recordProviderError("ZOHO_CRM", msg);
      return { ok: false, message: `Zoho CRM rejected the request: ${msg}`, latencyMs: Date.now() - t0 };
    } catch (err) {
      const msg = (err as Error).message;
      await recordProviderError("ZOHO_CRM", msg);
      return { ok: false, message: msg, latencyMs: Date.now() - t0 };
    }
  }

  async fetchContacts(opts: { modifiedSince?: Date | null; pageToken?: string | null; perPage?: number }): Promise<CrmPage> {
    const { config, apiDomain, fields } = await this.ctx();
    const params = new URLSearchParams({
      fields: fields.join(","),
      per_page: String(Math.min(200, opts.perPage ?? 200)),
      sort_by: "Modified_Time",
      sort_order: "asc",
    });
    if (opts.pageToken) params.set("page_token", opts.pageToken);
    const headers: Record<string, string> = {};
    if (opts.modifiedSince) headers["If-Modified-Since"] = formatInTimeZone(opts.modifiedSince, "Asia/Kolkata", "yyyy-MM-dd'T'HH:mm:ssXXX");
    const res = await zohoFetch<ZohoRecordsResponse>("ZOHO_CRM", `${apiDomain}/crm/v8/Contacts?${params}`, { headers });
    if (res.status === 304 || res.status === 204) return { records: [], nextPageToken: null, moreRecords: false };
    if (!res.ok) {
      const code = res.json?.code;
      throw new ProviderError("zoho_crm", `Get Contacts failed: ${res.json?.message ?? code ?? res.status}`, res.status, code, res.status === 429 || res.status >= 500);
    }
    await recordProviderSuccess("ZOHO_CRM");
    return {
      records: (res.json?.data ?? []).map((r) => mapZohoContact(r, config)),
      nextPageToken: res.json?.info?.next_page_token ?? null,
      moreRecords: !!res.json?.info?.more_records,
    };
  }

  async fetchDeleted(opts: { since?: Date | null; page: number }): Promise<CrmDeletedPage> {
    const { apiDomain } = await this.ctx();
    const headers: Record<string, string> = {};
    if (opts.since) headers["If-Modified-Since"] = formatInTimeZone(opts.since, "Asia/Kolkata", "yyyy-MM-dd'T'HH:mm:ssXXX");
    const res = await zohoFetch<{ data?: { id: string; deleted_time?: string }[]; info?: { more_records?: boolean } }>(
      "ZOHO_CRM",
      `${apiDomain}/crm/v8/Contacts/deleted?type=all&per_page=200&page=${opts.page}`,
      { headers },
    );
    if (res.status === 304 || res.status === 204) return { deleted: [], moreRecords: false };
    if (!res.ok) throw new ProviderError("zoho_crm", `Get deleted records failed: HTTP ${res.status}`, res.status);
    return {
      deleted: (res.json?.data ?? []).map((d) => ({ id: String(d.id), deletedTime: d.deleted_time ?? null })),
      moreRecords: !!res.json?.info?.more_records,
    };
  }
}
