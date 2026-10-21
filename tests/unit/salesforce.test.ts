import { describe, expect, it } from "vitest";
import { assertReadOnlyRequest } from "@/lib/salesforce/readonly";
import { buildContinueEnvelope, buildRetrieveEnvelope, dataExtensionRowValues, parseRetrieveResponse } from "@/lib/salesforce/soap";
import { classifyMessage } from "@/lib/salesforce/errors";
import { parseSfmcDate, toSfmcDateValue } from "@/lib/salesforce/dates";
import { unsupportedPropertiesFromError } from "@/lib/salesforce/objects";
import { reconcile, type EventRef } from "@/lib/domain/salesforce-reconcile";
import { csvCell } from "@/lib/services/salesforce/csv";

describe("read-only guarantee", () => {
  it("allows only Retrieve SOAP bodies", () => {
    const body = buildRetrieveEnvelope("https://x.soap.marketingcloudapis.com/Service.asmx", "tok", { objectType: "DataExtension", properties: ["Name"] });
    expect(() => assertReadOnlyRequest({ channel: "soap", method: "POST", soapAction: "Retrieve", body })).not.toThrow();
    expect(() => assertReadOnlyRequest({ channel: "soap", method: "POST", soapAction: "Retrieve", body: buildContinueEnvelope("https://x/Service.asmx", "t", "req-1") })).not.toThrow();
    for (const action of ["Create", "Update", "Delete", "Perform", "Configure", "Schedule", "Extract"]) {
      expect(() => assertReadOnlyRequest({ channel: "soap", method: "POST", soapAction: action, body })).toThrow(/only Retrieve/);
      const evil = `<s:Envelope><s:Body><RetrieveRequestMsg/><${action}RequestMsg xmlns="x"></${action}RequestMsg></s:Body></s:Envelope>`;
      expect(() => assertReadOnlyRequest({ channel: "soap", method: "POST", soapAction: "Retrieve", body: evil })).toThrow(/not a pure RetrieveRequestMsg/);
    }
  });

  it("allows only allow-listed REST reads", () => {
    expect(() => assertReadOnlyRequest({ channel: "rest", method: "GET", path: "/interaction/v1/interactions" })).not.toThrow();
    expect(() => assertReadOnlyRequest({ channel: "rest", method: "GET", path: "/asset/v1/content/assets?$page=2" })).not.toThrow();
    expect(() => assertReadOnlyRequest({ channel: "rest", method: "POST", path: "/asset/v1/content/assets/query" })).not.toThrow();
    for (const [m, p] of [
      ["POST", "/interaction/v1/interactions"],
      ["POST", "/interaction/v1/interactions/publishAsync/abc"],
      ["DELETE", "/asset/v1/content/assets/12"],
      ["PATCH", "/asset/v1/content/assets/12"],
      ["POST", "/messaging/v1/email/messages/abc"],
      ["POST", "/hub/v1/dataevents/key:DE/rowset"],
      ["POST", "/automation/v1/automations/abc/actions/runallonce"],
      ["GET", "/hub/v1/dataevents/key:DE/rowset"],
    ])
      expect(() => assertReadOnlyRequest({ channel: "rest", method: m, path: p })).toThrow(/Blocked/);
  });

  it("allows only token and userinfo on the auth host", () => {
    expect(() => assertReadOnlyRequest({ channel: "auth", method: "POST", path: "/v2/token" })).not.toThrow();
    expect(() => assertReadOnlyRequest({ channel: "auth", method: "GET", path: "/v2/userinfo" })).not.toThrow();
    expect(() => assertReadOnlyRequest({ channel: "auth", method: "POST", path: "/v2/revoke" })).toThrow();
  });
});

describe("SOAP codec", () => {
  const resp = (overall: string, results: string) =>
    `<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soap:Body><RetrieveResponseMsg xmlns="http://exacttarget.com/wsdl/partnerAPI"><OverallStatus>${overall}</OverallStatus><RequestID>r-1</RequestID>${results}</RetrieveResponseMsg></soap:Body></soap:Envelope>`;

  it("keeps values as exact strings (leading zeros, long ids, decimals, empty, nil)", () => {
    const xml = resp(
      "MoreDataAvailable",
      `<Results xsi:type="DataExtensionObject"><Properties><Property><Name>Code</Name><Value>007421</Value></Property><Property><Name>Big</Name><Value>12345678901234567890</Value></Property><Property><Name>Amt</Name><Value>10.50</Value></Property><Property><Name>Empty</Name><Value /></Property><Property><Name>Nil</Name><Value xsi:nil="true"/></Property><Property><Name>Amp</Name><Value>A &amp; B &lt;x&gt;</Value></Property></Properties></Results>`,
    );
    const page = parseRetrieveResponse(xml, 200);
    expect(page.moreData).toBe(true);
    expect(page.requestId).toBe("r-1");
    expect(dataExtensionRowValues(page.results[0])).toEqual({ Code: "007421", Big: "12345678901234567890", Amt: "10.50", Empty: "", Nil: null, Amp: "A & B <x>" });
  });

  it("raises classified errors for faults and Error statuses", () => {
    expect(() => parseRetrieveResponse(resp("Error: Insufficient privileges to retrieve SentEvent", ""), 200)).toThrow(expect.objectContaining({ kind: "permission" }));
    const fault = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring>Login failed: Token Expired</faultstring></soap:Fault></soap:Body></soap:Envelope>`;
    expect(() => parseRetrieveResponse(fault, 500)).toThrow(expect.objectContaining({ kind: "auth" }));
    expect(classifyMessage("Error: The ContinueRequest RequestID is invalid or expired")).toBe("continuation");
    expect(classifyMessage("Too many concurrent requests")).toBe("rate_limit");
  });

  it("escapes filter values and extracts unsupported properties", () => {
    const env = buildRetrieveEnvelope("https://x/Service.asmx", "t", { objectType: "SentEvent", properties: ["SendID"], filter: { property: "SubscriberKey", operator: "equals", values: ["a<b&c"] } });
    expect(env).toContain("<Value>a&lt;b&amp;c</Value>");
    expect(unsupportedPropertiesFromError("Error: The Request Property(s) PreviewURL, Foo do not match with the fields of Send retrieve")).toEqual(["PreviewURL", "Foo"]);
  });
});

describe("SFMC dates", () => {
  it("applies the configured source offset only when the value has none", () => {
    expect(parseSfmcDate("2025-09-12T04:30:00.000", "-06:00")?.toISOString()).toBe("2025-09-12T10:30:00.000Z");
    expect(parseSfmcDate("2025-09-12T04:30:00Z", "-06:00")?.toISOString()).toBe("2025-09-12T04:30:00.000Z");
    expect(parseSfmcDate("9/12/2025 4:30:00 PM", "-06:00")?.toISOString()).toBe("2025-09-12T22:30:00.000Z");
    expect(parseSfmcDate("not a date")).toBeNull();
    expect(parseSfmcDate("")).toBeNull();
    expect(toSfmcDateValue(new Date("2025-09-12T10:30:00Z"), "-06:00")).toBe("2025-09-12T04:30:00");
  });
});

describe("CSV safety", () => {
  it("neutralises spreadsheet formulas only in safe mode and quotes correctly", () => {
    expect(csvCell("=HYPERLINK(\"x\")", true)).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+91 98", true)).toBe("'+91 98");
    expect(csvCell("-5", true)).toBe("'-5");
    expect(csvCell("@SUM", true)).toBe("'@SUM");
    expect(csvCell("=1+1", false)).toBe("=1+1");
    expect(csvCell("007421", true)).toBe("007421");
    expect(csvCell("a,b\nc", true)).toBe(`"a,b\nc"`);
    expect(csvCell(null, true)).toBe("");
  });
});

describe("reconciliation classifier", () => {
  const ev = (k: string, d = "2025-09-12T10:00:00Z", t?: string): EventRef => ({ subscriberKey: k, jobId: "J1", eventDate: new Date(d), sourceEventType: t ?? null });
  const audienceOf = (vals: (string | null)[]) => vals.map((value, i) => ({ ref: { page: 1, row: i + 1 }, value }));

  it("classifies every audience row and never infers exclusion without evidence", () => {
    const { results, summary } = reconcile({
      audience: audienceOf(["A", "B", "C", "D", "E", "A", "", null, "F"]),
      mode: "SUBSCRIBER_KEY",
      caseInsensitive: false,
      trim: true,
      sent: [ev("A"), ev("B"), ev("Z")],
      notSent: [ev("C", undefined, "NotSent:Unsubscribed")],
      bounces: [ev("B")],
      unsubs: [],
      otherUnsubs: [ev("F", "2025-01-01T00:00:00Z")],
      subscriberStatus: new Map([["D", "Held"]]),
      exclusionMembers: new Set(),
      trackingAvailability: "AVAILABLE",
      sendDate: new Date("2025-09-12T09:00:00Z"),
    });
    const cls = (id: string | null, raw?: string | null) => results.find((r) => r.identity === id && (raw === undefined || r.rawIdentity === raw))?.classification;
    expect(cls("A")).toBe("MATCHED_SENT");
    expect(results.find((r) => r.identity === "B")!.flags).toContain("BOUNCE_EVENT");
    expect(cls("C")).toBe("AUDIENCE_NO_SENT_EVENT");
    expect(results.find((r) => r.identity === "C")!.evidence.evidenceLevel).toBe("VERIFIED_RECIPIENT_EVENT");
    expect(cls("D")).toBe("AUDIENCE_NO_SENT_EVENT");
    expect(results.find((r) => r.identity === "D")!.evidence.evidenceLevel).toBe("POSSIBLE_EXPLANATION_ONLY");
    expect(cls("E")).toBe("UNRESOLVED");
    expect(results.find((r) => r.identity === "F")!.flags).toContain("UNSUB_EVENT_BEFORE_SEND");
    expect(cls("Z")).toBe("TRACKING_NOT_IN_AUDIENCE");
    expect(summary.duplicateAudienceRows).toBe(1);
    expect(summary.invalidIdentifiers).toBe(2);
    expect(summary.audienceRows).toBe(9);
    expect(summary.uniqueRecipientsWithSentEvent).toBe(3);
    const last = summary.bridge[summary.bridge.length - 1];
    expect(last.value).toBe(3);
  });

  it("marks everything RETENTION_UNAVAILABLE when tracking is not retrievable", () => {
    const { summary } = reconcile({ audience: audienceOf(["A", "B"]), mode: "SUBSCRIBER_KEY", caseInsensitive: false, trim: true, sent: [], notSent: [], bounces: [], unsubs: [], trackingAvailability: "UNAVAILABLE" });
    expect(summary.retentionUnavailable).toBe(2);
    expect(summary.unresolved).toBe(0);
  });

  it("respects case sensitivity and supports email mapping", () => {
    const sensitive = reconcile({ audience: audienceOf(["abc"]), mode: "SUBSCRIBER_KEY", caseInsensitive: false, trim: true, sent: [ev("ABC")], notSent: [], bounces: [], unsubs: [], trackingAvailability: "AVAILABLE" });
    expect(sensitive.summary.matched).toBe(0);
    const insensitive = reconcile({ audience: audienceOf(["abc"]), mode: "SUBSCRIBER_KEY", caseInsensitive: true, trim: true, sent: [ev("ABC")], notSent: [], bounces: [], unsubs: [], trackingAvailability: "AVAILABLE" });
    expect(insensitive.summary.matched).toBe(1);
    const email = reconcile({
      audience: audienceOf(["X@Example.com", "nobody@example.com", "bad"]),
      mode: "EMAIL",
      caseInsensitive: false,
      trim: true,
      emailToKeys: new Map([["x@example.com", ["K1"]]]),
      sent: [ev("K1")],
      notSent: [],
      bounces: [],
      unsubs: [],
      trackingAvailability: "AVAILABLE",
    });
    expect(email.summary.matched).toBe(1);
    expect(email.summary.invalidIdentifiers).toBe(1);
    expect(email.results.find((r) => r.identity === "nobody@example.com")!.flags).toContain("EMAIL_NOT_IN_SUBSCRIBER_ARCHIVE");
  });
});

describe("archived HTML sanitiser", () => {
  it("removes scripts, handlers, frames and script URLs, and blocks remote images by default", async () => {
    const { sanitizeArchivedHtml, previewCsp } = await import("@/lib/salesforce/sanitize");
    const html = `<html><head><script>alert(1)</script><base href="https://evil"><meta http-equiv="refresh" content="0;url=x"></head><body onload="x()"><img src="https://img.example/a.png" onerror="y()"><a href="javascript:alert(2)">x</a><iframe src="https://evil"></iframe><div style="background:url(https://t.example/p.gif)">%%FirstName%%</div></body></html>`;
    const out = sanitizeArchivedHtml(html, { allowRemoteImages: false });
    expect(out.html).not.toMatch(/<script|onload|onerror|javascript:|<iframe|<base|http-equiv/i);
    expect(out.html).not.toMatch(/\ssrc="https:\/\/img\.example/);
    expect(out.html).toContain('data-archived-src="https://img.example/a.png"');
    expect(out.html).toContain("%%FirstName%%");
    expect(sanitizeArchivedHtml(html, { allowRemoteImages: true }).html).toContain('src="https://img.example/a.png"');
    expect(previewCsp(false)).toMatch(/default-src 'none'.*sandbox/);
    expect(previewCsp(false)).not.toMatch(/script-src/);
  });
});

describe("archive permissions", () => {
  it("keeps archived client data away from roles without archive access", async () => {
    const { hasPermission } = await import("@/lib/auth/permissions");
    for (const r of ["VIEWER", "CAMPAIGN_CREATOR", "APPROVER"] as const) expect(hasPermission(r, "archive:read")).toBe(false);
    expect(hasPermission("COMPLIANCE_OFFICER", "archive:read")).toBe(true);
    expect(hasPermission("COMPLIANCE_OFFICER", "archive:reconcile")).toBe(true);
    expect(hasPermission("COMPLIANCE_OFFICER", "archive:export")).toBe(true);
    expect(hasPermission("COMPLIANCE_OFFICER", "archive:manage")).toBe(false);
    expect(hasPermission("COMPLIANCE_OFFICER", "campaigns:write")).toBe(false);
    expect(hasPermission("ADMIN", "archive:manage")).toBe(true);
  });
});
