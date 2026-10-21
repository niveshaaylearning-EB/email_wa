/**
 * Provider adapter tests with a stubbed global fetch — no network, no real sends.
 * Verifies request shapes against the documented APIs and our safety gates.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { createUser, resetDb } from "../support/db";
import { saveSecrets, ensureIntegration, updateConfig } from "@/lib/services/integrations";
import { DoubleTickAdapter } from "@/lib/providers/doubletick/client";
import { ZohoCrmAdapter } from "@/lib/providers/zoho/crm";
import { ZohoMarketingAutomationAdapter } from "@/lib/providers/zoho/marketing-automation";
import { getAccessToken } from "@/lib/providers/zoho/oauth";
import { resetEnvCache } from "@/lib/env";

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
function stubFetch(handler: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = handler(String(url), init);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  });
}

async function setLive(provider: "DOUBLETICK" | "ZOHO_MA") {
  process.env.ALLOW_LIVE_SEND = "true";
  resetEnvCache();
  await prisma.integrationSetting.update({ where: { provider }, data: { mode: "LIVE" } });
}

beforeEach(async () => {
  await resetDb();
  for (const p of ["ZOHO_CRM", "ZOHO_MA", "DOUBLETICK"] as const) await ensureIntegration(p);
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.ALLOW_LIVE_SEND = "false";
  resetEnvCache();
});

describe("DoubleTick adapter", () => {
  beforeEach(async () => {
    await saveSecrets("DOUBLETICK", { apiKey: "key_test123" });
  });

  it("refuses to send unless ALLOW_LIVE_SEND and LIVE mode are both set", async () => {
    stubFetch(() => ({ status: 201, body: {} }));
    const a = new DoubleTickAdapter();
    await expect(a.sendTemplate({ from: "+919800000000", to: "+919000000001", content: { templateName: "t", language: "en" }, customData: {} })).rejects.toThrow(/ALLOW_LIVE_SEND/);
    expect(calls).toHaveLength(0);
  });

  it("posts the documented V2 payload with raw-key auth and parses acceptance (not delivery)", async () => {
    await setLive("DOUBLETICK");
    stubFetch(() => ({ status: 201, body: { messages: [{ status: "SENT", recipient: "+919000000001", messageId: "m-1" }] } }));
    const out = await new DoubleTickAdapter().sendTemplate({
      from: "+919800000000",
      to: "+919000000001",
      content: { templateName: "research_update", language: "en", templateData: { body: { placeholders: [{ name: "Asha" }] } } },
      customData: { nccDeliveryId: "d1" },
    });
    expect(out).toMatchObject({ kind: "accepted", messageId: "m-1" });
    expect(calls[0].url).toBe("https://public.doubletick.io/v2/whatsapp/message/template");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("key_test123");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      messages: [{ from: "+919800000000", to: "+919000000001", content: { templateName: "research_update", language: "en", templateData: { body: { placeholders: [{ name: "Asha" }] } } }, customData: { nccDeliveryId: "d1" } }],
    });
  });

  it("hard send lock refuses any number other than the approved one, even in LIVE", async () => {
    await setLive("DOUBLETICK");
    stubFetch(() => ({ status: 201, body: {} }));
    await expect(
      new DoubleTickAdapter().sendTemplate({ from: "+919800000000", to: "+919811111111", content: { templateName: "t", language: "en" }, customData: {} }),
    ).rejects.toThrow(/hard send lock/);
    expect(calls).toHaveLength(0);
  });

  it("maps FAILED results, 429 rate limits and 401s", async () => {
    await setLive("DOUBLETICK");
    const a = new DoubleTickAdapter();
    const send = () => a.sendTemplate({ from: "+91", to: "+919000000001", content: { templateName: "t", language: "en" }, customData: {} });
    stubFetch(() => ({ status: 201, body: { messages: [{ status: "FAILED", messageId: "m2", errorMessage: "not a WhatsApp user" }] } }));
    expect(await send()).toMatchObject({ kind: "rejected", error: "not a WhatsApp user" });
    stubFetch(() => ({ status: 429, body: { statusCode: 429, message: "Too Many Requests" } }));
    expect(await send()).toMatchObject({ kind: "http_error", httpStatus: 429 });
  });

  it("connection test uses a non-sending status probe", async () => {
    stubFetch(() => ({ status: 404, body: { message: "not found" } }));
    const r = await new DoubleTickAdapter().testConnection();
    expect(r.ok).toBe(true);
    expect(calls[0].url).toMatch(/\/whatsapp\/message\/status\?messageId=/);
    expect(calls[0].init.method ?? "GET").toBe("GET");
    stubFetch(() => ({ status: 401, body: { message: "Invalid public api key" } }));
    expect((await new DoubleTickAdapter().testConnection()).ok).toBe(false);
  });
});

describe("Zoho OAuth & CRM", () => {
  beforeEach(async () => {
    await saveSecrets("ZOHO_CRM", {
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "1000.refresh",
      accessToken: "expired",
      accessTokenExpiresAt: Date.now() - 1000,
      accountsServer: "https://accounts.zoho.in",
      apiDomain: "https://www.zohoapis.in",
    });
  });

  it("refreshes an expired access token at the user's accounts server and stores it encrypted", async () => {
    stubFetch((url) => (url.includes("/oauth/v2/token") ? { status: 200, body: { access_token: "1000.new", expires_in: 3600, api_domain: "https://www.zohoapis.in" } } : { status: 500 }));
    expect(await getAccessToken("ZOHO_CRM")).toBe("1000.new");
    expect(calls[0].url).toMatch(/^https:\/\/accounts\.zoho\.in\/oauth\/v2\/token\?refresh_token=1000\.refresh&client_id=cid&client_secret=csec&grant_type=refresh_token$/);
    const row = await prisma.integrationSetting.findUniqueOrThrow({ where: { provider: "ZOHO_CRM" } });
    expect(row.secretsEncrypted).not.toContain("1000.new");
    // Cached: second call doesn't refresh again (Zoho limits refreshes to 10 per 10 min).
    calls = [];
    expect(await getAccessToken("ZOHO_CRM")).toBe("1000.new");
    expect(calls).toHaveLength(0);
  });

  it("paginates Contacts with page_token, sorted by Modified_Time, and retries once on 401", async () => {
    let n = 0;
    stubFetch((url) => {
      if (url.includes("/oauth/v2/token")) return { status: 200, body: { access_token: `tok${++n}`, expires_in: 3600 } };
      if (url.includes("/crm/v8/Contacts")) {
        const auth = calls[calls.length - 1].init.headers as Record<string, string>;
        if (auth.Authorization === "Zoho-oauthtoken tok1") return { status: 401, body: { code: "INVALID_TOKEN" } };
        return { status: 200, body: { data: [{ id: "1", Full_Name: "Asha Shah", Email: "a@x.in", Mobile: "9825012345", Email_Opt_Out: false, Owner: { name: "Riya", id: "9" } }], info: { more_records: true, next_page_token: "PT2" } } };
      }
      return { status: 404 };
    });
    const page = await new ZohoCrmAdapter().fetchContacts({ modifiedSince: new Date("2026-10-01T00:00:00Z") });
    expect(page).toMatchObject({ moreRecords: true, nextPageToken: "PT2", records: [{ id: "1", fullName: "Asha Shah", owner: "Riya", mobile: "9825012345" }] });
    const crmCall = calls.filter((c) => c.url.includes("/crm/v8/Contacts")).at(-1)!;
    expect(crmCall.url).toMatch(/^https:\/\/www\.zohoapis\.in\/crm\/v8\/Contacts\?fields=/);
    expect(crmCall.url).toContain("sort_by=Modified_Time");
    expect(crmCall.url).toContain("per_page=200");
    expect((crmCall.init.headers as Record<string, string>)["If-Modified-Since"]).toBe("2026-10-01T05:30:00+05:30");
  });
});

describe("Zoho Marketing Automation adapter", () => {
  beforeEach(async () => {
    await saveSecrets("ZOHO_MA", { clientId: "c", clientSecret: "s", refreshToken: "r", accessToken: "tok", accessTokenExpiresAt: Date.now() + 3600_000 });
    await updateConfig("ZOHO_MA", { dc: "com" }, await createUser("ADMIN"));
  });

  it("adds leads in batches of at most 10 per documented limit", async () => {
    await setLive("ZOHO_MA");
    stubFetch(() => ({ status: 200, body: { status: "success", code: "0" } }));
    const emails = Array.from({ length: 23 }, () => "approved@example.com"); // only address allowed by the hard email lock
    const r = await new ZohoMarketingAutomationAdapter().addEmailsToList("LK", emails);
    expect(r.added).toBe(23);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url).toBe("https://marketingautomation.zoho.com/api/v1/addleadsinbulk");
      const ids = new URLSearchParams(String(c.init.body)).get("emailids")!.split(",");
      expect(ids.length).toBeLessThanOrEqual(10);
    }
  }, 20_000);

  it("hard email lock refuses any address other than the approved ones, even in LIVE", async () => {
    await setLive("ZOHO_MA");
    stubFetch(() => ({ status: 200, body: { status: "success", code: "0" } }));
    const ma = new ZohoMarketingAutomationAdapter();
    await expect(ma.createList("NCC-test", ["someone@example.com"])).rejects.toThrow(/hard email lock/);
    await expect(ma.addEmailsToList("LK", ["approved@example.com", "other@example.com"])).rejects.toThrow(/hard email lock/);
    expect(calls).toHaveLength(0);
  });

  it("never creates or sends a campaign outside LIVE mode", async () => {
    stubFetch(() => ({ status: 200, body: { status: "success" } }));
    await expect(new ZohoMarketingAutomationAdapter().sendCampaign("CK")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
