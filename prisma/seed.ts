/**
 * DEVELOPMENT SEED — loads clearly-labelled MOCK data by driving the real services with the
 * MOCK provider adapters. Every client is `is_mock = true` (CRM ids "MOCK-…"), every delivery is
 * `is_simulated = true`. Nothing is sent anywhere. Refuses to run when NODE_ENV=production.
 *
 *   npm run db:seed
 */
import "dotenv/config";
import { prisma } from "@/lib/db";
import { ensureRoles } from "@/lib/services/users";
import { hashPassword } from "@/lib/auth/session";
import { ensureIntegration } from "@/lib/services/integrations";
import { runCrmSync } from "@/lib/services/crm-sync";
import { addMembers, createCategory } from "@/lib/services/categories";
import { createTemplate, mapTemplateToCategory } from "@/lib/services/templates";
import { approveCampaign, createCampaignDraft, previewCampaignAudience, setReviewDecisions, submitForApproval } from "@/lib/services/campaigns";
import { drainInlineQueue, setInlineMode } from "@/lib/queue";
import { seeded } from "@/lib/providers/mock";
import { evaluateRuleById } from "@/lib/services/rules";
import type { RoleKey } from "@prisma/client";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed mock data in production.");
  process.exit(1);
}
process.env.ALLOW_LIVE_SEND = "false";
setInlineMode("manual");

const PASSWORD = process.env.SEED_ADMIN_PASSWORD || "Niveshaay@Dev2026";

async function user(email: string, name: string, role: RoleKey) {
  const r = await prisma.role.findUniqueOrThrow({ where: { key: role } });
  const u = await prisma.user.upsert({
    where: { email },
    create: { email, name, roleId: r.id, passwordHash: await hashPassword(PASSWORD) },
    update: {},
  });
  return { id: u.id, email: u.email, name: u.name, role, sessionId: "seed" };
}

async function main() {
  if (await prisma.client.count()) {
    console.log("Database already has clients — skipping seed (reset the dev DB to reseed).");
    return;
  }
  await ensureRoles();
  const admin = await user(process.env.SEED_ADMIN_EMAIL || "admin@niveshaay.local", "Jay Chaudhari", "ADMIN");
  const creator = await user("creator@niveshaay.local", "Jay Chaudhari", "CAMPAIGN_CREATOR");
  const approver = await user("approver@niveshaay.local", "Jay Chaudhari", "APPROVER");
  await user("viewer@niveshaay.local", "Jay Chaudhari", "VIEWER");
  for (const p of ["ZOHO_CRM", "ZOHO_MA", "DOUBLETICK"] as const) await ensureIntegration(p);

  // 1. Mock CRM sync (240 contacts with deliberate data-quality issues + one duplicate identity).
  const sync = await runCrmSync({ actor: admin, type: "INITIAL" });
  console.log("Mock CRM sync:", sync.stats);
  const clients = await prisma.client.findMany({ orderBy: { zohoCrmId: "asc" } });
  const rnd = seeded(7);

  // 2. Consents (mock evidence). ~78% WhatsApp opt-in; a few email unsubscribes.
  for (const c of clients) {
    if (rnd() < 0.78) await prisma.consent.create({ data: { clientId: c.id, channel: "WHATSAPP", status: "GRANTED", source: "MANUAL", evidence: "MOCK seed: WhatsApp opt-in captured during onboarding", recordedById: admin.id } });
    if (rnd() < 0.03) await prisma.consent.create({ data: { clientId: c.id, channel: "EMAIL", status: "REVOKED", source: "CLIENT_REQUEST", evidence: "MOCK seed: client asked to stop research emails", recordedById: admin.id } });
  }
  await prisma.suppressionEntry.create({ data: { channel: "WHATSAPP", identifierType: "PHONE", identifierValue: clients[5].phoneE164 ?? "+919000000005", reason: "DND", source: "seed", note: "MOCK seed: DND registry", clientId: clients[5].id } });

  // 3. Categories (dashboard-owned; nothing hardcoded in the app — these are seed examples).
  const defs = [
    { name: "Premium Research", description: "Full research subscribers receiving every stock note.", color: "#1E3A5F", priority: 10 },
    { name: "Small Cap Focus", description: "Clients subscribed to the small-cap basket.", color: "#0F8B6E", priority: 20 },
    { name: "Portfolio Advisory", description: "Model-portfolio advisory clients.", color: "#7C5CBF", priority: 30 },
    { name: "Event Invitees", description: "Shortlist for investor meet-ups and webinars.", color: "#D4A017", priority: 40 },
    { name: "Renewal Due", description: "Subscriptions due for renewal (dynamic rule on CRM status).", color: "#C2410C", priority: 50 },
    { name: "Trial Members", description: "Clients on a trial plan.", color: "#2563EB", priority: 60 },
  ];
  const cats = [];
  for (const d of defs) cats.push(await createCategory(d, creator));
  const [premium, smallcap, advisory, events, renewal, trial] = cats;
  const pick = (p: number) => clients.filter(() => rnd() < p).map((c) => c.id);
  await addMembers({ clientIds: pick(0.42), categoryIds: [premium.id], source: "BULK", note: "MOCK seed" }, creator);
  await addMembers({ clientIds: pick(0.3), categoryIds: [smallcap.id], source: "BULK", note: "MOCK seed" }, creator);
  await addMembers({ clientIds: pick(0.22), categoryIds: [advisory.id], source: "CSV", note: "MOCK seed (CSV)" }, creator);
  await addMembers({ clientIds: pick(0.15), categoryIds: [events.id], source: "MANUAL", note: "MOCK seed" }, creator);
  const trialIds = clients.filter((c) => (c.crmFields as { Plan?: string }).Plan === "Trial").map((c) => c.id);
  await addMembers({ clientIds: trialIds, categoryIds: [trial.id], source: "BULK", note: "MOCK seed" }, creator);
  const rule = await prisma.categoryRule.create({
    data: { categoryId: renewal.id, name: "CRM status is Renewal Due", definition: { match: "all", conditions: [{ field: "crmStatus", op: "equals", value: "Renewal Due" }] }, autoRemove: true, createdById: creator.id },
  });
  await evaluateRuleById(rule.id, creator);

  // 4. Templates (WhatsApp names are placeholders — link your real DoubleTick-approved names).
  const waVar = [{ key: "first_name", label: "First name", source: "client.firstName" as const, required: true, fallback: "Investor", sample: "Asha", waPlacement: "body" as const }];
  const tpl = async (channel: "EMAIL" | "WHATSAPP", name: string, body: string, extra: Record<string, unknown> = {}) =>
    createTemplate(
      {
        channel,
        name,
        body,
        approvalStatus: "APPROVED",
        variables: channel === "WHATSAPP" ? waVar : [],
        ...(channel === "WHATSAPP" ? { providerTemplateId: name.toLowerCase().replace(/[^a-z0-9]+/g, "_"), language: "en" } : { subject: extra.subject as string }),
        ...extra,
      } as never,
      creator,
    );
  const waPremium = await tpl("WHATSAPP", "Premium research alert", "Hi {{first_name}}, a new Premium Research note has been published on your Niveshaay dashboard.");
  const waSmall = await tpl("WHATSAPP", "Small cap basket update", "Hi {{first_name}}, the Small Cap Focus basket has been rebalanced. Log in to review the changes.");
  const waAdvisory = await tpl("WHATSAPP", "Advisory portfolio review", "Hi {{first_name}}, your model portfolio review for this quarter is ready.");
  const waEvent = await tpl("WHATSAPP", "Investor meet invitation", "Hi {{first_name}}, you're invited to the Niveshaay investor meet. Reply YES to reserve a seat.");
  const waRenewal = await tpl("WHATSAPP", "Renewal reminder", "Hi {{first_name}}, your Niveshaay subscription is due for renewal. Our team is happy to help.");
  const emPremium = await tpl("EMAIL", "Premium research email", "<h2>New Premium Research note</h2><p>Dear investor, a new note is available in your dashboard.</p>", { subject: "New Premium Research note — {{campaign_name}}", variables: [{ key: "campaign_name", label: "Campaign name", source: "campaign.name", required: true }] });
  const emSmall = await tpl("EMAIL", "Small cap monthly email", "<h2>Small Cap Focus — monthly update</h2><p>Dear investor, here is this month's small-cap commentary.</p>", { subject: "Small Cap Focus — monthly update" });
  const emEvent = await tpl("EMAIL", "Investor meet email", "<h2>You're invited</h2><p>Join the Niveshaay investor meet. RSVP from your dashboard.</p>", { subject: "Invitation: Niveshaay investor meet" });
  await createTemplate({ channel: "WHATSAPP", name: "Trial welcome (pending approval)", providerTemplateId: "trial_welcome", language: "en", body: "Welcome {{first_name}}! Your trial is active.", variables: waVar, approvalStatus: "PENDING" }, creator);
  const maps: [string, string][] = [
    [premium.id, waPremium.id], [premium.id, emPremium.id], [smallcap.id, waSmall.id], [smallcap.id, emSmall.id],
    [advisory.id, waAdvisory.id], [events.id, waEvent.id], [events.id, emEvent.id], [renewal.id, waRenewal.id], [advisory.id, emPremium.id],
  ];
  for (const [categoryId, templateId] of maps) await mapTemplateToCategory({ categoryId, templateId, isDefault: true }, creator);

  await prisma.internalTestRecipient.createMany({ data: [{ name: "Compliance Desk", email: "compliance@niveshaay.local", phoneE164: "+919800000101" }, { name: "Karan Mehta", email: "karan@niveshaay.local", phoneE164: "+919800000102" }] });

  // 5. Campaigns executed through the real pipeline with MOCK adapters, backdated for chart history.
  const runCampaign = async (name: string, draft: Parameters<typeof createCampaignDraft>[0], daysAgo: number) => {
    const c = await createCampaignDraft(draft, creator);
    let p = await previewCampaignAudience(c.id);
    if (p.summary.needsReview) {
      await setReviewDecisions(
        c.id,
        p.reviewItems.filter((r) => r.status === "NEEDS_REVIEW").map((r) => ({ clientId: r.clientId, channel: r.channel, decision: { categoryId: r.conflictCategoryIds[0] } })),
        creator,
      );
      p = await previewCampaignAudience(c.id);
    }
    await submitForApproval(c.id, creator);
    await approveCampaign(c.id, { confirmMessageCount: p.summary.messageVolume, confirmLive: false, note: "MOCK seed approval" }, approver);
    await drainInlineQueue();
    const shift = `${daysAgo} days`;
    await prisma.$executeRawUnsafe(
      `UPDATE message_deliveries SET created_at = created_at - interval '${shift}', submitted_at = submitted_at - interval '${shift}', accepted_at = accepted_at - interval '${shift}', sent_at = sent_at - interval '${shift}', delivered_at = delivered_at - interval '${shift}', read_at = read_at - interval '${shift}', opened_at = opened_at - interval '${shift}', clicked_at = clicked_at - interval '${shift}', failed_at = failed_at - interval '${shift}' WHERE campaign_id = $1`,
      c.id,
    );
    await prisma.campaign.update({ where: { id: c.id }, data: { createdAt: new Date(Date.now() - (daysAgo + 1) * 86400_000), approvedAt: new Date(Date.now() - daysAgo * 86400_000), startedAt: new Date(Date.now() - daysAgo * 86400_000), completedAt: new Date(Date.now() - daysAgo * 86400_000 + 3600_000) } });
    console.log(`  ✓ ${name}: ${p.summary.messageVolume} simulated messages`);
    return c;
  };
  const base = { purpose: "RESEARCH_UPDATE" as const, scheduleType: "IMMEDIATE" as const, rateLimitPerMinute: 6000, overlapStrategy: "MANUAL_REVIEW" as const };
  console.log("Simulated campaigns:");
  await runCampaign("Q3 results — premium", { ...base, name: "Q3 results — Premium note", channelMode: "BOTH", categories: [{ categoryId: premium.id, priority: 1, emailTemplateId: emPremium.id, whatsappTemplateId: waPremium.id }] }, 24);
  await runCampaign("Small cap rebalance", { ...base, name: "Small cap rebalance — September", channelMode: "WHATSAPP", categories: [{ categoryId: smallcap.id, priority: 1, whatsappTemplateId: waSmall.id }] }, 17);
  await runCampaign("Investor meet", { ...base, purpose: "EVENT_INVITATION", name: "Ahmedabad investor meet", channelMode: "BOTH", categories: [{ categoryId: events.id, priority: 1, emailTemplateId: emEvent.id, whatsappTemplateId: waEvent.id }] }, 9);
  await runCampaign("Multi-category research", {
    ...base,
    name: "Weekly research digest",
    channelMode: "WHATSAPP",
    overlapStrategy: "PRIORITY",
    categories: [
      { categoryId: premium.id, priority: 1, whatsappTemplateId: waPremium.id },
      { categoryId: smallcap.id, priority: 2, whatsappTemplateId: waSmall.id },
      { categoryId: advisory.id, priority: 3, whatsappTemplateId: waAdvisory.id },
    ],
  }, 3);

  // Pending approval, draft and scheduled examples.
  const pending = await createCampaignDraft({ ...base, purpose: "SERVICE_NOTICE", name: "Renewal reminders — October", channelMode: "WHATSAPP", categories: [{ categoryId: renewal.id, priority: 1, whatsappTemplateId: waRenewal.id }] }, creator);
  await submitForApproval(pending.id, creator);
  await createCampaignDraft({ ...base, name: "Advisory + Premium overlap (draft)", channelMode: "WHATSAPP", categories: [{ categoryId: premium.id, priority: 1, whatsappTemplateId: waPremium.id }, { categoryId: advisory.id, priority: 2, whatsappTemplateId: waAdvisory.id }] }, creator);
  const sched = await createCampaignDraft(
    { ...base, purpose: "EVENT_INVITATION", name: "Webinar reminder", channelMode: "EMAIL", scheduleType: "SCHEDULED", scheduledAtLocal: new Date(Date.now() + 3 * 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 11) + "11:00", categories: [{ categoryId: events.id, priority: 1, emailTemplateId: emEvent.id }] },
    creator,
  );
  const sp = await previewCampaignAudience(sched.id);
  await submitForApproval(sched.id, creator);
  await approveCampaign(sched.id, { confirmMessageCount: sp.summary.messageVolume, confirmLive: false }, approver);

  console.log("\nSeed complete. Sign in with any of (password: %s):", PASSWORD);
  console.log("  admin    →", admin.email);
  console.log("  creator  → creator@niveshaay.local");
  console.log("  approver → approver@niveshaay.local");
  console.log("  viewer   → viewer@niveshaay.local");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
