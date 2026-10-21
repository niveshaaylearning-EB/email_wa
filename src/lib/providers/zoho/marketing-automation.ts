/**
 * Zoho Marketing Automation v1 adapter.
 * Docs: https://www.zoho.com/marketingautomation/help/developers/v1/
 *   add-new-leads-list.html (addlistandleads), add-contacts-existing-list.html (addleadsinbulk, ≤10 emails/call),
 *   get-mailing-lists.html, create-campaign.html, send-campaign.html, campaign-reports.html,
 *   campaign-recipient-data.html (getcampaignrecipientsdata)
 *
 * Rate limit: 500 calls / 5 min per API (exceeding locks that API for 30 min) → we self-throttle.
 * Content can only be supplied as a public `content_url`; there is no documented API to attach
 * an existing template, so the dashboard hosts the approved HTML at an unguessable URL.
 * Regional hosts other than marketingautomation.zoho.com are not documented (configurable).
 */
import "server-only";
import { zohoFetch } from "./oauth";
import { getDataCenter } from "./dc";
import { assertLiveSendAllowed, loadIntegration, recordProviderError, recordProviderSuccess } from "@/lib/services/integrations";
import { EMAIL_LOCK_MESSAGE, isApprovedRealSendEmail } from "@/lib/send-allowlist";
import { ProviderError, type ConnectionTestResult, type EmailCampaignProvider, type EmailCampaignReport, type EmailRecipientAction } from "../types";

const BATCH = 10; // documented max emails per addleadsinbulk call
const MIN_INTERVAL_MS = 650; // ≈ 460 calls / 5 min — stays under the 500 / 5 min lock threshold

let lastCall = 0;
async function throttle() {
  const wait = lastCall + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

type MaJson = Record<string, unknown> & { status?: string; code?: string | number; message?: string };

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export class ZohoMarketingAutomationAdapter implements EmailCampaignProvider {
  readonly kind = "real" as const;

  private async base() {
    const { config } = await loadIntegration("ZOHO_MA");
    return `${(config.baseUrl ?? getDataCenter(config.dc).marketingAutomation).replace(/\/$/, "")}/api/v1`;
  }

  private async call(method: string, params: Record<string, string>, httpMethod: "GET" | "POST" = "POST"): Promise<MaJson> {
    await throttle();
    const base = await this.base();
    const qs = new URLSearchParams({ resfmt: "JSON", ...params });
    const url = httpMethod === "GET" ? `${base}/${method}?${qs}` : `${base}/${method}`;
    const res = await zohoFetch<MaJson>("ZOHO_MA", url, {
      method: httpMethod,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      ...(httpMethod === "POST" ? { body: qs.toString() } : {}),
    });
    const j = res.json ?? {};
    const failed = !res.ok || j.status === "error" || (j.code !== undefined && !["0", "200", 0, 200].includes(j.code as string | number));
    if (failed) {
      const msg = `${method} failed: ${j.message ?? j.code ?? `HTTP ${res.status}`}`;
      await recordProviderError("ZOHO_MA", msg);
      throw new ProviderError("zoho_ma", msg, res.status, j.code !== undefined ? String(j.code) : undefined, res.status === 429 || res.status >= 500);
    }
    await recordProviderSuccess("ZOHO_MA");
    return j;
  }

  async testConnection(): Promise<ConnectionTestResult> {
    const t0 = Date.now();
    try {
      const j = await this.call("getmailinglists", { sort: "desc", fromindex: "1", range: "1" }, "GET");
      await recordProviderSuccess("ZOHO_MA", { status: "CONNECTED", accountInfo: { baseUrl: await this.base() } });
      return { ok: true, message: "Connected to Zoho Marketing Automation (list read access confirmed).", accountInfo: { sample: Object.keys(j) }, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, message: (err as Error).message, latencyMs: Date.now() - t0 };
    }
  }

  async createList(name: string, firstEmails: string[], description?: string) {
    await assertLiveSendAllowed("ZOHO_MA");
    if (!firstEmails.every(isApprovedRealSendEmail)) throw new ProviderError("zoho_ma", EMAIL_LOCK_MESSAGE);
    const j = await this.call("addlistandleads", {
      listname: name,
      signupform: "private",
      mode: "newlist",
      emailids: firstEmails.slice(0, BATCH).join(","),
      ...(description ? { listdescription: description } : {}),
      // Accounts with topic management require a topic (verified 2026-10-21: createCampaign
      // fails with "Mandatory Fields are not found" without topicId).
      ...(await this.topicParam()),
    });
    const listKey = String(j.listkey ?? "");
    if (!listKey) throw new ProviderError("zoho_ma", "addlistandleads returned no listkey");
    return { listKey };
  }

  private async topicParam(): Promise<Record<string, string>> {
    const { config } = await loadIntegration("ZOHO_MA");
    return config.topicId ? { topic_id: config.topicId } : {};
  }

  async addEmailsToList(listKey: string, emails: string[]) {
    await assertLiveSendAllowed("ZOHO_MA");
    if (!emails.every(isApprovedRealSendEmail)) throw new ProviderError("zoho_ma", EMAIL_LOCK_MESSAGE);
    let added = 0;
    const failedBatches: { emails: string[]; error: string }[] = [];
    for (let i = 0; i < emails.length; i += BATCH) {
      const batch = emails.slice(i, i + BATCH);
      try {
        await this.call("addleadsinbulk", { listkey: listKey, emailids: batch.join(","), ...(await this.topicParam()) });
        added += batch.length;
      } catch (err) {
        failedBatches.push({ emails: batch, error: (err as Error).message });
      }
    }
    return { added, failedBatches };
  }

  async getListLeadCount(listKey: string) {
    // getmailinglists has no documented key filter; page through and match listkey.
    for (let from = 1; from < 5000; from += 100) {
      const j = await this.call("getmailinglists", { sort: "desc", fromindex: String(from), range: "100" }, "GET");
      const lists = (j.list_of_details as { listkey?: string; noofleads?: string | number }[]) ?? [];
      const hit = lists.find((l) => l.listkey === listKey);
      if (hit) return num(hit.noofleads);
      if (lists.length < 100) break;
    }
    return null;
  }

  async createCampaign(input: { name: string; fromEmail: string; fromName?: string; subject: string; listKey: string; contentUrl: string; topicId?: string }) {
    await assertLiveSendAllowed("ZOHO_MA");
    const j = await this.call("createCampaign", {
      campaignname: input.name,
      from_email: input.fromEmail,
      subject: input.subject,
      list_details: JSON.stringify({ [input.listKey]: [] }),
      content_url: input.contentUrl,
      ...(input.fromName ? { from_name: input.fromName } : {}),
      ...(input.topicId ? { topicId: input.topicId } : {}),
    });
    const campaignKey = String(j.campaignKey ?? j.campaignkey ?? "");
    if (!campaignKey) throw new ProviderError("zoho_ma", "createCampaign returned no campaignKey");
    return { campaignKey };
  }

  async sendCampaign(campaignKey: string) {
    await assertLiveSendAllowed("ZOHO_MA");
    const j = await this.call("sendcampaign", { campaignkey: campaignKey });
    const resp = (j.response as Record<string, unknown>) ?? j;
    return { status: (resp.campaign_status as string) ?? null };
  }

  async getCampaignReport(campaignKey: string): Promise<EmailCampaignReport> {
    const j = await this.call("campaignreports", { campaignkey: campaignKey }, "GET");
    const r = ((j["campaign-reports"] as Record<string, unknown>[]) ?? [])[0] ?? (j["campaign-reports"] as Record<string, unknown>) ?? {};
    return {
      sent: num(r.emails_sent_count),
      delivered: num(r.delivered_count),
      opens: num(r.opens_count),
      uniqueClicks: num(r.unique_clicks_count),
      bounces: num(r.bounces_count),
      hardBounces: num(r.hardbounce_count),
      softBounces: num(r.softbounce_count),
      unsubscribes: num(r.unsub_count),
      complaints: num(r.complaints_count),
      unsent: num(r.unsent_count),
      status: (j.campaign_status as string) ?? null,
      raw: r,
    };
  }

  async getCampaignRecipients(campaignKey: string, action: EmailRecipientAction, fromIndex: number, range: number) {
    const j = await this.call("getcampaignrecipientsdata", {
      campaignkey: campaignKey,
      action,
      fromindex: String(fromIndex),
      range: String(range),
    });
    const rows = (j.list_of_details as { leademailaddress?: string; sent_time?: string }[]) ?? [];
    return rows.filter((r) => r.leademailaddress).map((r) => ({ email: r.leademailaddress!.toLowerCase(), time: r.sent_time ?? null }));
  }
}
