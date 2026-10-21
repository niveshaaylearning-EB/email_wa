import { describe, expect, it } from "vitest";
import { renderTemplate, validateTemplateDefinition, type RenderableTemplate } from "@/lib/domain/template-render";
import { assertTransition, canTransition, TransitionError } from "@/lib/domain/campaign-state";
import { classifyHttpOutcome, shouldAdvance } from "@/lib/domain/delivery-status";
import { evaluateRule, RuleDefinitionSchema } from "@/lib/domain/rules";
import { normalizePhone } from "@/lib/phone";
import { normalizeEmail } from "@/lib/email";
import { maskDeep, maskEmail, maskPhone } from "@/lib/mask";
import { decryptJson, encryptJson, stableHash } from "@/lib/crypto";

const wa: RenderableTemplate = {
  id: "t1",
  channel: "WHATSAPP",
  name: "Research update",
  providerTemplateId: "research_update_v2",
  language: "en",
  subject: null,
  body: "Hi {{first_name}}, our {{report}} note is live.",
  header: { type: "DOCUMENT", mediaUrl: "https://cdn.example.com/r.pdf" },
  variables: [
    { key: "first_name", label: "First name", source: "client.firstName", required: true, fallback: "Investor", waPlacement: "body", waParamName: "name" },
    { key: "report", label: "Report", source: "static", staticValue: "Q3 Pharma", required: true, waPlacement: "body" },
    { key: "link", label: "Link slug", source: "static", staticValue: "q3-pharma", required: true, waPlacement: "button_url" },
  ],
};

describe("template rendering", () => {
  it("builds a DoubleTick V2 content object with key-value body placeholders", () => {
    const r = renderTemplate(wa, { client: { firstName: "Asha" } });
    expect(r.body).toBe("Hi Asha, our Q3 Pharma note is live.");
    expect(r.whatsapp).toEqual({
      templateName: "research_update_v2",
      language: "en",
      templateData: {
        header: { type: "DOCUMENT", mediaUrl: "https://cdn.example.com/r.pdf" },
        body: { placeholders: [{ name: "Asha" }, { report: "Q3 Pharma" }] },
        buttons: [{ type: "URL", parameter: "q3-pharma" }],
      },
    });
  });

  it("uses fallback, and reports missing required values", () => {
    expect(renderTemplate(wa, { client: {} }).body).toContain("Hi Investor");
    const noFallback = { ...wa, variables: wa.variables.map((v) => ({ ...v, fallback: undefined })) };
    expect(renderTemplate(noFallback, { client: {} }).missing).toEqual(["first_name"]);
  });

  it("rejects undeclared placeholders and per-recipient email variables", () => {
    const email: RenderableTemplate = {
      ...wa,
      channel: "EMAIL",
      subject: "Update for {{first_name}}",
      body: "<p>{{unknown}}</p>",
      header: null,
      variables: [{ key: "first_name", label: "First", source: "client.firstName", required: true }],
    };
    const msgs = validateTemplateDefinition(email).filter((i) => i.level === "error").map((i) => i.message);
    expect(msgs.some((m) => m.includes("{{unknown}}"))).toBe(true);
    expect(msgs.some((m) => m.includes("per-recipient data"))).toBe(true);
  });

  it("valid WhatsApp template has no errors", () => {
    expect(validateTemplateDefinition(wa).filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("campaign state machine", () => {
  it("enforces maker-checker flow", () => {
    expect(assertTransition("submit", "DRAFT")).toBe("PENDING_APPROVAL");
    expect(assertTransition("approve", "PENDING_APPROVAL")).toBe("APPROVED");
    expect(() => assertTransition("approve", "DRAFT")).toThrow(TransitionError);
    expect(canTransition("queue", "PENDING_APPROVAL")).toBe(false);
    expect(canTransition("cancel", "COMPLETED")).toBe(false);
    expect(assertTransition("reject", "PENDING_APPROVAL")).toBe("REJECTED");
    expect(assertTransition("revise", "REJECTED")).toBe("DRAFT");
  });
});

describe("delivery status ordering", () => {
  it("never regresses on out-of-order or duplicate events", () => {
    expect(shouldAdvance("ACCEPTED", "DELIVERED")).toBe(true);
    expect(shouldAdvance("READ", "DELIVERED")).toBe(false);
    expect(shouldAdvance("DELIVERED", "DELIVERED")).toBe(false);
    expect(shouldAdvance("SENT", "FAILED")).toBe(true);
    expect(shouldAdvance("FAILED", "READ")).toBe(true);
    expect(shouldAdvance("DELIVERED", "FAILED")).toBe(false);
    expect(shouldAdvance("DRY_RUN", "SENT")).toBe(false);
  });

  it("classifies retries conservatively", () => {
    expect(classifyHttpOutcome({ status: 429 })).toBe("retryable");
    expect(classifyHttpOutcome({ status: 400 })).toBe("permanent");
    expect(classifyHttpOutcome({ status: 500 })).toBe("unconfirmed");
    expect(classifyHttpOutcome({ networkError: "after_send" })).toBe("unconfirmed");
    expect(classifyHttpOutcome({ networkError: "before_send" })).toBe("retryable");
  });
});

describe("dynamic rules", () => {
  const subject = {
    crmStatus: "Active",
    city: "Ahmedabad",
    phoneCountry: "IN",
    crmOwner: "Riya",
    emailNormalized: "a@niveshaay.com",
    phoneValid: true,
    crmFields: { Plan: "Premium", KYC_Done: true },
  };
  it("evaluates all/any rules", () => {
    const rule = RuleDefinitionSchema.parse({
      match: "all",
      conditions: [
        { field: "city", op: "in", value: ["ahmedabad", "Surat"] },
        { field: "crmField", crmFieldKey: "Plan", op: "equals", value: "premium" },
        { field: "hasValidPhone", op: "is_true" },
      ],
    });
    expect(evaluateRule(subject, rule)).toBe(true);
    expect(evaluateRule({ ...subject, city: "Pune" }, rule)).toBe(false);
    expect(evaluateRule({ ...subject, city: "Pune" }, { ...rule, match: "any" })).toBe(true);
  });
  it("rejects invalid definitions", () => {
    expect(RuleDefinitionSchema.safeParse({ match: "all", conditions: [{ field: "city", op: "equals" }] }).success).toBe(false);
  });
});

describe("normalization & masking", () => {
  it("normalizes Indian and international numbers", () => {
    expect(normalizePhone("98765 43210")?.e164).toBe("+919876543210");
    expect(normalizePhone("919876543210")?.e164).toBe("+919876543210");
    expect(normalizePhone("+44 20 7946 0958")).toMatchObject({ e164: "+442079460958", country: "GB", countryCode: "44" });
    expect(normalizePhone("0091 98765-43210")?.e164).toBe("+919876543210");
    expect(normalizePhone("12345")?.valid).toBe(false);
    expect(normalizePhone("")).toBeNull();
  });
  it("normalizes emails", () => {
    expect(normalizeEmail("  Asha@Example.COM ")).toBe("asha@example.com");
    expect(normalizeEmail("not-an-email")).toBeNull();
  });
  it("masks PII and redacts secrets", () => {
    expect(maskEmail("asha.patel@example.com")).toBe("as********@example.com");
    expect(maskPhone("+919876543210")).toBe("+91******3210");
    const masked = maskDeep({ access_token: "abc", email: "asha@example.com", nested: { note: "call +919876543210" } });
    expect(masked).toEqual({ access_token: "[REDACTED]", email: "as**@example.com", nested: { note: "call +91******3210" } });
  });
  it("encrypts credentials with AES-GCM and detects tampering", () => {
    const env = encryptJson({ refreshToken: "1000.secret" });
    expect(env).not.toContain("secret");
    expect(decryptJson(env)).toEqual({ refreshToken: "1000.secret" });
    const tampered = env.slice(0, -2) + (env.endsWith("A") ? "BB" : "AA");
    expect(() => decryptJson(tampered)).toThrow();
  });
  it("stable hash ignores key order", () => {
    expect(stableHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(stableHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });
});
