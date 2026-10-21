import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createClient, createUser, grantConsent, resetDb } from "../support/db";
import { addMembers, createCategory, archiveCategory, importMembershipCsv } from "@/lib/services/categories";
import { createTemplate, mapTemplateToCategory } from "@/lib/services/templates";
import {
  approveCampaign,
  cancelCampaign,
  createCampaignDraft,
  previewCampaignAudience,
  rejectCampaign,
  setReviewDecisions,
  submitForApproval,
  updateCampaignDraft,
} from "@/lib/services/campaigns";
import { drainInlineQueue } from "@/lib/queue";
import { overrideProviders } from "@/lib/providers/registry";
import { handleDoubleTickStatusWebhook } from "@/lib/services/webhooks";
import type { WhatsAppProvider, WhatsAppSendOutcome } from "@/lib/providers/types";
import { runCrmSync } from "@/lib/services/crm-sync";
import { MockCrmAdapter } from "@/lib/providers/mock";
import type { CampaignDraft } from "@/lib/contracts";

async function setup() {
  const creator = await createUser("CAMPAIGN_CREATOR");
  const approver = await createUser("APPROVER");
  const c1 = await createCategory({ name: "Premium Research", color: "#1E3A5F", priority: 1 }, creator);
  const c2 = await createCategory({ name: "Small Cap", color: "#0F8B6E", priority: 2 }, creator);
  const wa1 = await createTemplate(
    {
      channel: "WHATSAPP",
      name: "Premium update",
      providerTemplateId: "premium_update",
      language: "en",
      body: "Hi {{first_name}}, new premium note.",
      variables: [{ key: "first_name", label: "First name", source: "client.firstName", required: true, waPlacement: "body" }],
      approvalStatus: "APPROVED",
    },
    creator,
  );
  const wa2 = await createTemplate(
    { channel: "WHATSAPP", name: "Small cap update", providerTemplateId: "smallcap_update", language: "en", body: "Small cap note is out.", variables: [], approvalStatus: "APPROVED" },
    creator,
  );
  const em1 = await createTemplate({ channel: "EMAIL", name: "Premium email", subject: "Premium research", body: "<p>Hello</p>", variables: [], approvalStatus: "APPROVED" }, creator);
  await mapTemplateToCategory({ categoryId: c1.id, templateId: wa1.id, isDefault: true }, creator);
  await mapTemplateToCategory({ categoryId: c2.id, templateId: wa2.id, isDefault: true }, creator);
  await mapTemplateToCategory({ categoryId: c1.id, templateId: em1.id, isDefault: true }, creator);
  return { creator, approver, c1, c2, wa1, wa2, em1 };
}

function waDraft(s: Awaited<ReturnType<typeof setup>>, over: Partial<CampaignDraft> = {}): CampaignDraft {
  return {
    name: "October research",
    purpose: "RESEARCH_UPDATE",
    channelMode: "WHATSAPP",
    overlapStrategy: "MANUAL_REVIEW",
    categories: [
      { categoryId: s.c1.id, priority: 1, whatsappTemplateId: s.wa1.id },
      { categoryId: s.c2.id, priority: 2, whatsappTemplateId: s.wa2.id },
    ],
    scheduleType: "IMMEDIATE",
    rateLimitPerMinute: 6000,
    ...over,
  };
}

describe("campaign flow (MOCK providers, real PostgreSQL)", () => {
  beforeEach(resetDb);

  it("multi-category clients, overlap review, maker-checker approval, frozen snapshot, simulated execution", async () => {
    const s = await setup();
    const a = await createClient(); // C1 only
    const b = await createClient(); // C2 only
    const c = await createClient(); // C1 + C2 → conflicting templates
    const noConsent = await createClient(); // C1, no WhatsApp opt-in
    const outsider = await createClient(); // no category
    for (const x of [a, b, c, outsider]) await grantConsent(x.id);
    await addMembers({ clientIds: [a.id, c.id, noConsent.id], categoryIds: [s.c1.id], source: "MANUAL" }, s.creator);
    await addMembers({ clientIds: [b.id, c.id], categoryIds: [s.c2.id], source: "BULK" }, s.creator);

    const camp = await createCampaignDraft(waDraft(s), s.creator);
    let preview = await previewCampaignAudience(camp.id);
    expect(preview.summary.uniqueClients).toBe(4);
    expect(preview.summary.overlappingClients).toBe(1);
    expect(preview.summary.needsReview).toBe(1);
    expect(preview.summary.noConsent).toBe(1);
    expect(preview.sample.map((r) => r.clientId)).not.toContain(outsider.id);
    await expect(submitForApproval(camp.id, s.creator)).rejects.toThrow(/validation errors/);

    await setReviewDecisions(camp.id, [{ clientId: c.id, channel: "WHATSAPP", decision: { categoryId: s.c2.id } }], s.creator);
    preview = await previewCampaignAudience(camp.id);
    expect(preview.summary.needsReview).toBe(0);
    expect(preview.summary.messageVolume).toBe(3);
    await submitForApproval(camp.id, s.creator);

    // Maker-checker: creator cannot approve their own campaign.
    await expect(approveCampaign(camp.id, { confirmMessageCount: 3, confirmLive: false }, s.creator)).rejects.toThrow(/Maker-checker/);
    // Stale count is rejected.
    await expect(approveCampaign(camp.id, { confirmMessageCount: 99, confirmLive: false }, s.approver)).rejects.toThrow(/audience changed/);
    await approveCampaign(camp.id, { confirmMessageCount: 3, confirmLive: false, note: "ok" }, s.approver);

    const frozen = await prisma.campaignMessageAssignment.findMany({ where: { campaignId: camp.id, status: "PLANNED" }, include: { recipient: true } });
    expect(frozen).toHaveLength(3);
    const cAssign = frozen.find((f) => f.recipient.clientId === c.id)!;
    expect(cAssign.templateId).toBe(s.wa2.id); // reviewer decision honoured
    expect((frozen.find((f) => f.recipient.clientId === a.id)!.rendered as { whatsapp: unknown }).whatsapp).toMatchObject({
      templateName: "premium_update",
      templateData: { body: { placeholders: [{ first_name: a.firstName }] } },
    });

    // Membership changes after approval must not alter the frozen audience.
    const late = await createClient();
    await grantConsent(late.id);
    await addMembers({ clientIds: [late.id], categoryIds: [s.c1.id], source: "MANUAL" }, s.creator);
    // DB trigger blocks tampering with the frozen audience.
    await expect(prisma.campaignRecipient.deleteMany({ where: { campaignId: camp.id } })).rejects.toThrow(/frozen/);
    await expect(prisma.campaignSnapshot.updateMany({ where: { campaignId: camp.id }, data: { contentHash: "x" } })).rejects.toThrow(/immutable/);

    await drainInlineQueue();
    const finalCampaign = await prisma.campaign.findUniqueOrThrow({ where: { id: camp.id } });
    expect(finalCampaign.status).toBe("COMPLETED");
    const deliveries = await prisma.messageDelivery.findMany({ where: { campaignId: camp.id } });
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every((d) => d.isSimulated)).toBe(true);
    expect(deliveries.map((d) => d.clientId)).not.toContain(late.id);
    // Simulated lifecycle went through the shared webhook-processing path.
    expect(deliveries.every((d) => ["DELIVERED", "READ", "FAILED"].includes(d.status))).toBe(true);
    const events = await prisma.deliveryEvent.findMany({ where: { deliveryId: { in: deliveries.map((d) => d.id) } } });
    expect(events.every((e) => e.source === "SIMULATION" || e.source === "SYSTEM")).toBe(true);
    const audits = await prisma.auditLog.findMany({ where: { campaignId: camp.id }, orderBy: { createdAt: "asc" } });
    expect(audits.map((x) => x.action)).toEqual(expect.arrayContaining(["campaign.created", "campaign.submitted", "campaign.approved", "campaign.execution_started", "campaign.execution_completed"]));
  });

  it("rejection returns to creator and editing moves it back to draft; cancellation cancels pending deliveries", async () => {
    const s = await setup();
    const a = await createClient();
    await grantConsent(a.id);
    await addMembers({ clientIds: [a.id], categoryIds: [s.c1.id], source: "MANUAL" }, s.creator);
    const camp = await createCampaignDraft(waDraft(s, { categories: [{ categoryId: s.c1.id, priority: 1, whatsappTemplateId: s.wa1.id }] }), s.creator);
    await submitForApproval(camp.id, s.creator);
    await rejectCampaign(camp.id, "Wrong audience", s.approver);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: camp.id } })).status).toBe("REJECTED");
    await updateCampaignDraft(camp.id, waDraft(s, { name: "Fixed", categories: [{ categoryId: s.c1.id, priority: 1, whatsappTemplateId: s.wa1.id }] }), s.creator);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: camp.id } })).status).toBe("DRAFT");

    await submitForApproval(camp.id, s.creator);
    await approveCampaign(camp.id, { confirmMessageCount: 1, confirmLive: false }, s.approver);
    await cancelCampaign(camp.id, "Changed plans", s.approver);
    await drainInlineQueue();
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: camp.id } });
    expect(c.status).toBe("CANCELLED");
    expect(await prisma.messageDelivery.count({ where: { campaignId: camp.id, status: { notIn: ["CANCELLED"] } } })).toBe(0);
  });

  it("blocks unauthorised template/category combinations and archiving categories in active campaigns", async () => {
    const s = await setup();
    await expect(
      createCampaignDraft(waDraft(s, { categories: [{ categoryId: s.c1.id, priority: 1, whatsappTemplateId: s.wa2.id }] }), s.creator),
    ).rejects.toThrow(/not authorised/);
    const a = await createClient();
    await grantConsent(a.id);
    await addMembers({ clientIds: [a.id], categoryIds: [s.c1.id], source: "MANUAL" }, s.creator);
    const camp = await createCampaignDraft(waDraft(s, { categories: [{ categoryId: s.c1.id, priority: 1, whatsappTemplateId: s.wa1.id }] }), s.creator);
    await submitForApproval(camp.id, s.creator);
    await expect(archiveCategory(s.c1.id, s.creator)).rejects.toThrow(/active campaign/);
  });

  it("retries rate-limited sends, never auto-retries unconfirmed submissions, and is idempotent", async () => {
    const s = await setup();
    const clients = [await createClient(), await createClient(), await createClient()];
    for (const c of clients) await grantConsent(c.id);
    await addMembers({ clientIds: clients.map((c) => c.id), categoryIds: [s.c1.id], source: "MANUAL" }, s.creator);
    const calls: string[] = [];
    let n = 0;
    const flaky: WhatsAppProvider = {
      kind: "real",
      testConnection: async () => ({ ok: true, message: "" }),
      getMessageStatus: async () => null,
      sendTemplate: async (input): Promise<WhatsAppSendOutcome> => {
        calls.push(input.to);
        n++;
        if (input.to === clients[0].phoneE164 && calls.filter((x) => x === input.to).length === 1) return { kind: "http_error", httpStatus: 429, error: "rate limited", raw: {} };
        if (input.to === clients[1].phoneE164) return { kind: "http_error", httpStatus: 500, error: "internal", raw: {} };
        return { kind: "accepted", providerStatus: "SENT", messageId: `msg-${n}`, httpStatus: 201, raw: {} };
      },
    };
    overrideProviders({ whatsapp: flaky });
    const camp = await createCampaignDraft(waDraft(s, { categories: [{ categoryId: s.c1.id, priority: 1, whatsappTemplateId: s.wa1.id }] }), s.creator);
    await submitForApproval(camp.id, s.creator);
    await approveCampaign(camp.id, { confirmMessageCount: 3, confirmLive: false }, s.approver);
    // Force retry timing to "now" so the drained retry job is not skipped as early.
    await drainInlineQueue();
    await prisma.messageDelivery.updateMany({ where: { campaignId: camp.id, status: "QUEUED" }, data: { nextAttemptAt: new Date() } });
    const { sendWhatsAppDelivery } = await import("@/lib/services/execution");
    for (const d of await prisma.messageDelivery.findMany({ where: { campaignId: camp.id, status: "QUEUED" } })) await sendWhatsAppDelivery(d.id);
    await drainInlineQueue();

    const byClient = Object.fromEntries((await prisma.messageDelivery.findMany({ where: { campaignId: camp.id } })).map((d) => [d.clientId, d]));
    expect(byClient[clients[0].id].status).toBe("ACCEPTED");
    expect(byClient[clients[0].id].attemptCount).toBe(2);
    expect(byClient[clients[1].id]).toMatchObject({ status: "FAILED", failureCode: "UNCONFIRMED_SUBMISSION", attemptCount: 1 });
    expect(calls.filter((x) => x === clients[1].phoneE164)).toHaveLength(1);
    // Re-running sends for already-accepted deliveries is a no-op (claim fails).
    const before = calls.length;
    for (const d of Object.values(byClient)) await sendWhatsAppDelivery(d.id);
    expect(calls.length).toBe(before);
  });

  it("webhooks: rejects bad auth, dedupes duplicate deliveries, never regresses status", async () => {
    const s = await setup();
    const a = await createClient();
    await grantConsent(a.id);
    await addMembers({ clientIds: [a.id], categoryIds: [s.c1.id], source: "MANUAL" }, s.creator);
    overrideProviders({
      whatsapp: {
        kind: "real",
        testConnection: async () => ({ ok: true, message: "" }),
        getMessageStatus: async () => null,
        sendTemplate: async () => ({ kind: "accepted", providerStatus: "SENT", messageId: "dt-123", httpStatus: 201, raw: {} }),
      },
    });
    const camp = await createCampaignDraft(waDraft(s, { categories: [{ categoryId: s.c1.id, priority: 1, whatsappTemplateId: s.wa1.id }] }), s.creator);
    await submitForApproval(camp.id, s.creator);
    await approveCampaign(camp.id, { confirmMessageCount: 1, confirmLive: false }, s.approver);
    await drainInlineQueue();
    const h = (auth?: string) => new Headers(auth ? { authorization: auth, "content-type": "application/json" } : {});
    const read = JSON.stringify({ messageId: "dt-123", to: "919876500001", status: "READ", statusTimestamp: "2026-10-16T10:05:00Z" });
    const delivered = JSON.stringify({ messageId: "dt-123", status: "DELIVERED", statusTimestamp: "2026-10-16T10:01:00Z" });

    expect((await handleDoubleTickStatusWebhook(read, h())).status).toBe(401);
    expect((await handleDoubleTickStatusWebhook(read, h("Bearer wrong"))).status).toBe(401);
    expect((await handleDoubleTickStatusWebhook(read, h("Bearer test-webhook-secret"))).body).toMatchObject({ processed: 1 });
    expect((await handleDoubleTickStatusWebhook(read, h("Bearer test-webhook-secret"))).body).toMatchObject({ duplicates: 1 });
    await handleDoubleTickStatusWebhook(delivered, h("Bearer test-webhook-secret")); // out of order
    const d = await prisma.messageDelivery.findFirstOrThrow({ where: { campaignId: camp.id } });
    expect(d.status).toBe("READ");
    expect(d.deliveredAt).not.toBeNull();
    expect(await prisma.webhookEvent.count({ where: { status: "REJECTED" } })).toBe(2);
    expect(await prisma.deliveryEvent.count({ where: { deliveryId: d.id, source: "WEBHOOK" } })).toBe(2); // READ + late DELIVERED (recorded, not applied)
  });
});

describe("CRM sync & memberships", () => {
  beforeEach(resetDb);

  it("never overwrites dashboard memberships, flags duplicate identities, normalizes phones", async () => {
    const admin = await createUser("ADMIN");
    const contacts = [
      { id: "Z1", firstName: "Asha", lastName: "Shah", fullName: "Asha Shah", email: "asha@x.in", secondaryEmail: null, phone: null, mobile: "098250 12345", emailOptOut: false, modifiedTime: "2026-10-01T10:00:00Z", owner: "Riya", city: "Ahmedabad", status: "Active", extra: {} },
      { id: "Z2", firstName: "Asha", lastName: "S", fullName: "Asha S", email: "ASHA@x.in", secondaryEmail: null, phone: null, mobile: null, emailOptOut: false, modifiedTime: "2026-10-02T10:00:00Z", owner: "Riya", city: null, status: "Active", extra: {} },
    ];
    overrideProviders({ crm: new MockCrmAdapter(contacts) });
    await runCrmSync({ actor: admin });
    const z1 = await prisma.client.findUniqueOrThrow({ where: { zohoCrmId: "Z1" } });
    expect(z1.phoneE164).toBe("+919825012345");
    expect((await prisma.client.findUniqueOrThrow({ where: { zohoCrmId: "Z2" } })).duplicateOfId).toBe(z1.id);

    const cat = await createCategory({ name: "HNI", color: "#1E3A5F", priority: 1 }, admin);
    await addMembers({ clientIds: [z1.id], categoryIds: [cat.id], source: "MANUAL" }, admin);
    contacts[0].fullName = "Asha Shah (updated)";
    contacts[0].modifiedTime = new Date().toISOString();
    await runCrmSync({ actor: admin, full: true });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: z1.id } })).fullName).toBe("Asha Shah (updated)");
    expect(await prisma.clientCategory.count({ where: { clientId: z1.id, removedAt: null } })).toBe(1);
  });

  it("CSV membership import validates, matches existing CRM clients only, and is idempotent", async () => {
    const admin = await createUser("ADMIN");
    const a = await createClient({ email: "one@x.in", emailNormalized: "one@x.in" });
    await createClient({ phoneRaw: "9811111111", phoneE164: "+919811111111" });
    const cat = await createCategory({ name: "Event invitees", color: "#1E3A5F", priority: 1 }, admin);
    const csv = `email,phone,zoho_crm_id\none@x.in,,\n,98111 11111,\nnobody@x.in,,\n,,\n,,${a.zohoCrmId}\n`;
    const dry = await importMembershipCsv({ categoryId: cat.id, csv, dryRun: true }, admin);
    expect(dry.summary).toMatchObject({ matched: 2, notFound: 1, invalid: 1, alreadyMember: 1 });
    expect(await prisma.clientCategory.count({ where: { categoryId: cat.id } })).toBe(0);
    await importMembershipCsv({ categoryId: cat.id, csv, dryRun: false }, admin);
    expect(await prisma.clientCategory.count({ where: { categoryId: cat.id } })).toBe(2);
    const again = await importMembershipCsv({ categoryId: cat.id, csv, dryRun: false }, admin);
    expect(again.summary.matched).toBe(0);
  });

  it("audit log is append-only at the database level", async () => {
    const admin = await createUser("ADMIN");
    await createCategory({ name: "X", color: "#1E3A5F", priority: 1 }, admin);
    await expect(prisma.auditLog.updateMany({ data: { action: "tampered" } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
  });
});
