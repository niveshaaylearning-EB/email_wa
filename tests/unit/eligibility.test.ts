import { describe, expect, it } from "vitest";
import {
  computeEligibility,
  type AudienceClient,
  type AudienceMember,
  type EligibilityInput,
  type SelectedCategory,
} from "@/lib/domain/eligibility";

const client = (id: string, over: Partial<AudienceClient> = {}): AudienceClient => ({
  id,
  fullName: `Client ${id}`,
  emailRaw: `${id}@example.com`,
  emailNormalized: `${id.toLowerCase()}@example.com`,
  phoneRaw: "9876543210",
  phoneE164: `+9198765${id.padStart(5, "0").slice(-5)}`,
  phoneValid: true,
  crmEmailOptOut: false,
  crmStatus: "Active",
  deletedInCrmAt: null,
  duplicateOfId: null,
  ...over,
});

// Categories: C1 (priority 1) → T-E1/T-W1, C2 (priority 2) → T-E2/T-W2, C3 shares C1's templates.
const cats: SelectedCategory[] = [
  { categoryId: "C1", priority: 1, templates: { EMAIL: "T-E1", WHATSAPP: "T-W1" } },
  { categoryId: "C2", priority: 2, templates: { EMAIL: "T-E2", WHATSAPP: "T-W2" } },
  { categoryId: "C3", priority: 3, templates: { EMAIL: "T-E1", WHATSAPP: "T-W1" } },
];

function input(members: AudienceMember[], over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    campaignId: "camp1",
    channels: ["EMAIL", "WHATSAPP"],
    strategy: "MANUAL_REVIEW",
    categories: cats,
    members,
    consents: new Map(members.map((m) => [m.client.id, { EMAIL: "GRANTED", WHATSAPP: "GRANTED" } as const])),
    suppressions: new Set(),
    consentPolicy: { EMAIL: "OPT_OUT", WHATSAPP: "OPT_IN" },
    inactiveCrmStatuses: ["Inactive"],
    ...over,
  };
}

describe("computeEligibility — multi-category membership", () => {
  it("Client A in C1+C3 (same templates) gets exactly one message per channel, no conflict", () => {
    const r = computeEligibility(input([{ client: client("A"), categoryIds: ["C1", "C3"] }]));
    const a = r.recipients[0];
    expect(a.status).toBe("ELIGIBLE");
    expect(a.assignments).toHaveLength(2);
    expect(a.assignments.map((x) => [x.channel, x.categoryId, x.templateId])).toEqual([
      ["EMAIL", "C1", "T-E1"],
      ["WHATSAPP", "C1", "T-W1"],
    ]);
    expect(r.summary.overlappingClients).toBe(1);
    expect(r.summary.conflicts).toBe(0);
    expect(r.summary.totalMemberships).toBe(2);
    expect(r.summary.uniqueClients).toBe(1);
  });

  it("conflicting templates default to MANUAL_REVIEW and never silently pick one", () => {
    const r = computeEligibility(input([{ client: client("C"), categoryIds: ["C1", "C2"] }]));
    const c = r.recipients[0];
    expect(c.status).toBe("NEEDS_REVIEW");
    expect(c.assignments.every((a) => a.status === "NEEDS_REVIEW")).toBe(true);
    expect(c.assignments[0].conflictCategoryIds).toEqual(["C1", "C2"]);
    expect(r.summary.messageVolume).toBe(0);
    expect(r.summary.needsReview).toBe(1);
  });

  it("reviewer decision resolves the conflict to the chosen category's template", () => {
    const r = computeEligibility(
      input([{ client: client("C"), categoryIds: ["C1", "C2"] }], {
        reviewDecisions: new Map([["C", { EMAIL: { categoryId: "C2" }, WHATSAPP: { exclude: true } }]]),
      }),
    );
    const c = r.recipients[0];
    expect(c.status).toBe("ELIGIBLE");
    expect(c.assignments.find((a) => a.channel === "EMAIL")).toMatchObject({ templateId: "T-E2", status: "PLANNED" });
    expect(c.assignments.find((a) => a.channel === "WHATSAPP")).toMatchObject({ status: "EXCLUDED", reasons: ["CONFLICT_EXCLUDED"] });
  });

  it("PRIORITY picks the highest-priority category", () => {
    const r = computeEligibility(input([{ client: client("C"), categoryIds: ["C2", "C1"] }], { strategy: "PRIORITY" }));
    expect(r.recipients[0].assignments.map((a) => a.templateId)).toEqual(["T-E1", "T-W1"]);
  });

  it("PER_CATEGORY sends one message per distinct template, deduplicating same-template categories", () => {
    const r = computeEligibility(input([{ client: client("C"), categoryIds: ["C1", "C2", "C3"] }], { strategy: "PER_CATEGORY" }));
    const keys = r.recipients[0].assignments.map((a) => `${a.channel}:${a.templateId}`);
    expect(keys.sort()).toEqual(["EMAIL:T-E1", "EMAIL:T-E2", "WHATSAPP:T-W1", "WHATSAPP:T-W2"]);
    expect(new Set(r.recipients[0].assignments.map((a) => a.idempotencyKey)).size).toBe(4);
    expect(r.summary.messageVolume).toBe(4);
  });

  it("EXCLUDE_CONFLICTS drops only conflicting recipients", () => {
    const r = computeEligibility(
      input(
        [
          { client: client("A"), categoryIds: ["C1"] },
          { client: client("C"), categoryIds: ["C1", "C2"] },
        ],
        { strategy: "EXCLUDE_CONFLICTS" },
      ),
    );
    expect(r.recipients.find((x) => x.clientId === "A")!.status).toBe("ELIGIBLE");
    expect(r.recipients.find((x) => x.clientId === "C")!.status).toBe("EXCLUDED");
    expect(r.summary.exclusionCounts.CONFLICT_EXCLUDED).toBe(1);
  });

  it("clients outside the selected categories never leak into the audience", () => {
    const r = computeEligibility(
      input(
        [
          { client: client("A"), categoryIds: ["C1"] },
          { client: client("Z"), categoryIds: ["C9"] },
        ],
        { categories: [cats[0]] },
      ),
    );
    expect(r.recipients.map((x) => x.clientId)).toEqual(["A"]);
  });
});

describe("computeEligibility — contact, consent and suppression", () => {
  it("excludes missing email/phone per channel only", () => {
    const r = computeEligibility(
      input([
        { client: client("A", { emailRaw: null, emailNormalized: null }), categoryIds: ["C1"] },
        { client: client("B", { phoneRaw: null, phoneE164: null, phoneValid: false }), categoryIds: ["C1"] },
        { client: client("D", { phoneRaw: "12", phoneE164: null, phoneValid: false }), categoryIds: ["C1"] },
      ]),
    );
    const [a, b, d] = r.recipients;
    expect(a.channelDecisions.EMAIL?.reasons).toEqual(["MISSING_EMAIL"]);
    expect(a.status).toBe("ELIGIBLE"); // WhatsApp still allowed
    expect(b.channelDecisions.WHATSAPP?.reasons).toEqual(["MISSING_PHONE"]);
    expect(d.channelDecisions.WHATSAPP?.reasons).toEqual(["INVALID_PHONE"]);
    expect(r.summary.missingEmail).toBe(1);
    expect(r.summary.missingPhone).toBe(2);
  });

  it("WhatsApp requires opt-in consent; email honours revocation and CRM opt-out", () => {
    const members = [
      { client: client("A"), categoryIds: ["C1"] },
      { client: client("B", { crmEmailOptOut: true }), categoryIds: ["C1"] },
      { client: client("C"), categoryIds: ["C1"] },
    ];
    const r = computeEligibility(
      input(members, {
        consents: new Map([
          ["A", {}],
          ["B", { WHATSAPP: "GRANTED" }],
          ["C", { EMAIL: "REVOKED", WHATSAPP: "REVOKED" }],
        ]),
      }),
    );
    const byId = Object.fromEntries(r.recipients.map((x) => [x.clientId, x]));
    expect(byId.A.channelDecisions.EMAIL?.allowed).toBe(true); // OPT_OUT policy
    expect(byId.A.channelDecisions.WHATSAPP?.reasons).toEqual(["NO_CONSENT"]);
    expect(byId.B.channelDecisions.EMAIL?.reasons).toEqual(["CRM_OPT_OUT"]);
    expect(byId.C.status).toBe("EXCLUDED");
    expect(byId.C.exclusionReasons).toEqual(["UNSUBSCRIBED"]);
  });

  it("suppression list applies per channel and across all channels", () => {
    const r = computeEligibility(
      input(
        [
          { client: client("A"), categoryIds: ["C1"] },
          { client: client("B"), categoryIds: ["C1"] },
        ],
        { suppressions: new Set(["EMAIL:a@example.com", `ALL:${client("B").phoneE164}`]) },
      ),
    );
    const [a, b] = r.recipients;
    expect(a.channelDecisions.EMAIL?.reasons).toEqual(["SUPPRESSED"]);
    expect(a.channelDecisions.WHATSAPP?.allowed).toBe(true);
    expect(b.channelDecisions.WHATSAPP?.reasons).toEqual(["SUPPRESSED"]);
  });

  it("exclusions beat conflicts: a suppressed conflicting client is excluded, not queued for review", () => {
    const r = computeEligibility(
      input([{ client: client("C"), categoryIds: ["C1", "C2"] }], {
        channels: ["EMAIL"],
        suppressions: new Set(["EMAIL:c@example.com"]),
      }),
    );
    expect(r.recipients[0].status).toBe("EXCLUDED");
    expect(r.summary.needsReview).toBe(0);
  });

  it("deduplicates two CRM records sharing one email/phone (first by id wins)", () => {
    const shared = { emailNormalized: "same@example.com", emailRaw: "same@example.com", phoneE164: "+919800000001" };
    const r = computeEligibility(
      input([
        { client: client("B", shared), categoryIds: ["C1"] },
        { client: client("A", shared), categoryIds: ["C1"] },
      ]),
    );
    const byId = Object.fromEntries(r.recipients.map((x) => [x.clientId, x]));
    expect(byId.A.status).toBe("ELIGIBLE");
    expect(byId.B.status).toBe("EXCLUDED");
    expect(byId.B.exclusionReasons).toEqual(["DUPLICATE_IDENTITY"]);
  });

  it("excludes inactive, CRM-deleted and merged-duplicate clients", () => {
    const r = computeEligibility(
      input([
        { client: client("A", { crmStatus: "inactive" }), categoryIds: ["C1"] },
        { client: client("B", { deletedInCrmAt: new Date() }), categoryIds: ["C1"] },
        { client: client("D", { duplicateOfId: "A" }), categoryIds: ["C1"] },
      ]),
    );
    expect(r.recipients.every((x) => x.status === "EXCLUDED")).toBe(true);
    expect(r.summary.inactive).toBe(2);
  });

  it("missing per-recipient template data excludes only that assignment", () => {
    const r = computeEligibility(
      input([{ client: client("A"), categoryIds: ["C1"] }], {
        missingTemplateData: (_c, t) => (t === "T-W1" ? ["first_name"] : []),
      }),
    );
    const a = r.recipients[0];
    expect(a.assignments.find((x) => x.channel === "WHATSAPP")?.reasons).toContain("MISSING_TEMPLATE_DATA");
    expect(a.status).toBe("ELIGIBLE");
  });
});

describe("computeEligibility — scale & determinism", () => {
  it("handles 50k members deterministically with unique idempotency keys", () => {
    const members: AudienceMember[] = Array.from({ length: 50_000 }, (_, i) => ({
      client: client(String(i), { emailNormalized: `u${i}@x.in`, emailRaw: `u${i}@x.in`, phoneE164: `+91900${String(i).padStart(7, "0")}` }),
      categoryIds: i % 3 === 0 ? ["C1", "C3"] : i % 3 === 1 ? ["C2"] : ["C1"],
    }));
    const t0 = Date.now();
    const r1 = computeEligibility(input(members, { strategy: "PRIORITY" }));
    expect(Date.now() - t0).toBeLessThan(5000);
    const r2 = computeEligibility(input([...members].reverse(), { strategy: "PRIORITY" }));
    expect(r1.summary).toEqual(r2.summary);
    const keys = r1.recipients.flatMap((r) => r.assignments.map((a) => a.idempotencyKey));
    expect(new Set(keys).size).toBe(keys.length);
    expect(r1.summary.messageVolume).toBe(100_000);
  });
});
