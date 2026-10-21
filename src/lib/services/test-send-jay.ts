/**
 * TEST MODULE — send one test email (Zoho Marketing Automation) and one WhatsApp (DoubleTick
 * onboarding bot) to Jay Chaudhari at the same time. Remove after testing
 * (docs/doubletick-onboarding-test.md).
 *
 * Hard-locked: emails and WhatsApp go only to the approved recipients in the local, git-ignored
 * config/send-allowlist.local.json (src/lib/send-allowlist.ts). The global ALLOW_LIVE_SEND switch
 * stays OFF, so campaigns still cannot send — this path only ever reaches the locked addresses.
 *
 * Zoho MA flow (docs: /api/v1 addlistandleads → createCampaign → sendcampaign):
 * content is supplied as a public `content_url` that Zoho fetches when the campaign is created.
 */
import "server-only";
import { prisma } from "@/lib/db";
import { audit, type AuditActor } from "@/lib/audit";
import { badRequest, forbidden } from "@/lib/errors";
import { zohoFetch } from "@/lib/providers/zoho/oauth";
import { getDataCenter } from "@/lib/providers/zoho/dc";
import { loadIntegration } from "./integrations";
import { triggerOnboarding, type TriggerResult } from "./onboarding-trigger";
import { approvedRealSendEmails, approvedRealSendNumbers, EMAIL_LOCK_MESSAGE, isApprovedRealSendEmail } from "@/lib/send-allowlist";

export const TEST_SEND_ACTION = "automation.test_send_jay";
export const TEST_EMAIL_SUBJECT = "Test email from Niveshaay Communication Center";

export function testEmailHtml(name: string) {
  const safe = name.replace(/[<>&"]/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${TEST_EMAIL_SUBJECT}</title></head>
<body style="margin:0;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#101828">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;border:1px solid #e4e7ec">
<tr><td style="background:#1E3A5F;color:#ffffff;padding:20px 24px;border-radius:10px 10px 0 0;font-size:18px;font-weight:bold">Niveshaay Communication Center</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.6">
<p>Hi ${safe},</p>
<p>This is a <strong>test email</strong> sent through Zoho Marketing Automation from the Niveshaay Communication Center test dashboard, at the same time as the WhatsApp onboarding message.</p>
<p>If you received this, the email integration works end to end.</p>
<p style="color:#5d6b82;font-size:13px">Test only — sent to an approved internal address. No client received this message.</p>
</td></tr></table></td></tr></table></body></html>`;
}

type MaJson = Record<string, unknown> & { status?: string; code?: string | number; message?: string };

async function maCall(method: string, params: Record<string, string>): Promise<MaJson> {
  const { config } = await loadIntegration("ZOHO_MA");
  const base = `${(config.baseUrl ?? getDataCenter(config.dc).marketingAutomation).replace(/\/$/, "")}/api/v1`;
  const body = new URLSearchParams({ resfmt: "JSON", ...params });
  const res = await zohoFetch<MaJson>("ZOHO_MA", `${base}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const j = res.json ?? {};
  const failed = !res.ok || j.status === "error" || (j.code !== undefined && !["0", "200", 0, 200].includes(j.code as string | number));
  if (failed) throw new Error(`${method} failed: ${j.message ?? j.code ?? `HTTP ${res.status}`}`);
  return j;
}

export interface EmailTestResult {
  outcome: "sent" | "failed";
  to: string;
  listKey?: string;
  campaignKey?: string;
  providerStatus?: string | null;
  error?: string;
}

export async function sendTestEmail(input: { to: string | string[]; name: string; contentUrl: string }, actor: AuditActor): Promise<EmailTestResult> {
  const recipients = [...new Set((Array.isArray(input.to) ? input.to : [input.to]).map((e) => e.trim().toLowerCase()))];
  if (!recipients.length || recipients.length > 10) throw badRequest("Send to between 1 and 10 approved addresses.");
  if (!recipients.every(isApprovedRealSendEmail)) throw forbidden(EMAIL_LOCK_MESSAGE);
  if (!/^https:\/\/[^\s]+$/.test(input.contentUrl)) throw badRequest("contentUrl must be a public https URL.");
  const ma = await loadIntegration("ZOHO_MA");
  if (!ma.secrets.refreshToken) throw badRequest("Zoho Marketing Automation is not connected.");
  if (!ma.config.fromEmail) throw badRequest("Set the From email on the Zoho Marketing Automation card first.");
  const result: EmailTestResult = { outcome: "failed", to: recipients.join(", ") };
  try {
    const list = await maCall("addlistandleads", {
      listname: `NCC-TEST-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`,
      signupform: "private",
      mode: "newlist",
      emailids: recipients.join(","),
      ...(ma.config.topicId ? { topic_id: ma.config.topicId } : {}),
      listdescription: "Niveshaay Communication Center test list (approved internal address only)",
    });
    result.listKey = String(list.listkey ?? "");
    if (!result.listKey) throw new Error("addlistandleads returned no listkey");
    const camp = await maCall("createCampaign", {
      campaignname: `NCC test — ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
      from_email: ma.config.fromEmail,
      from_name: ma.config.fromName ?? "Niveshaay",
      subject: TEST_EMAIL_SUBJECT,
      list_details: JSON.stringify({ [result.listKey]: [] }),
      content_url: input.contentUrl,
      ...(ma.config.topicId ? { topicId: ma.config.topicId } : {}),
    });
    result.campaignKey = String(camp.campaignKey ?? camp.campaignkey ?? "");
    if (!result.campaignKey) throw new Error("createCampaign returned no campaignKey");
    const sent = await maCall("sendcampaign", { campaignkey: result.campaignKey });
    const resp = (sent.response as Record<string, unknown>) ?? sent;
    result.providerStatus = (resp.campaign_status as string) ?? null;
    result.outcome = "sent";
  } catch (err) {
    result.error = (err as Error).message;
  }
  await audit({ actor, action: TEST_SEND_ACTION, entityType: "test_recipient", metadata: { channel: "EMAIL", ...result, recipients } });
  return result;
}

/** Sends the email and the WhatsApp at the same time to the one approved recipient. */
export async function sendTestToJay(input: { contentUrl: string; confirm?: string; channels?: ("EMAIL" | "WHATSAPP")[] }, actor: AuditActor) {
  const channels = input.channels?.length ? input.channels : (["EMAIL", "WHATSAPP"] as const);
  if (input.confirm !== "SEND") throw badRequest("Type SEND to confirm a real email and WhatsApp message.");
  const jay = await prisma.internalTestRecipient.findFirst({
    // The first approved number/email in the local allowlist is the owner's test recipient.
    where: { isActive: true, phoneE164: approvedRealSendNumbers()[0] ?? "-", email: approvedRealSendEmails()[0] ?? "-" },
  });
  if (!jay) throw badRequest("Approved test recipient (Jay Chaudhari) is not set up in Settings → Test recipients.");
  const [email, whatsapp] = await Promise.all([
    channels.includes("EMAIL") ? sendTestEmail({ to: jay.email!, name: jay.name, contentUrl: input.contentUrl }, actor) : null,
    channels.includes("WHATSAPP")
      ? triggerOnboarding({ testRecipientId: jay.id, dryRun: false, confirm: "SEND" }, actor).catch(
          (e: Error): TriggerResult => ({ outcome: "failed", target: { kind: "test_recipient", name: jay.name, phoneE164: jay.phoneE164 }, payload: null, blockers: [], error: e.message }),
        )
      : null,
  ]);
  return { email, whatsapp };
}

/** Team test: one Zoho email campaign to approved addresses + one WhatsApp per approved test recipient, in parallel. */
export async function sendTeamTest(input: { contentUrl: string; confirm?: string; emails: string[]; testRecipientIds: string[] }, actor: AuditActor) {
  if (input.confirm !== "SEND") throw badRequest("Type SEND to confirm real emails and WhatsApp messages.");
  const recipients = await prisma.internalTestRecipient.findMany({ where: { id: { in: input.testRecipientIds }, isActive: true } });
  if (recipients.length !== input.testRecipientIds.length) throw badRequest("Unknown or inactive test recipient.");
  const spacedWhatsApp = async () => {
    const out: TriggerResult[] = [];
    for (const r of recipients) {
      out.push(
        await triggerOnboarding({ testRecipientId: r.id, dryRun: false, confirm: "SEND" }, actor).catch(
          (e: Error): TriggerResult => ({ outcome: "failed", target: { kind: "test_recipient", name: r.name, phoneE164: r.phoneE164 }, payload: null, blockers: [], error: e.message }),
        ),
      );
      await new Promise((res) => setTimeout(res, 1500));
    }
    return out;
  };
  const [email, whatsapp] = await Promise.all([
    input.emails.length ? sendTestEmail({ to: input.emails, name: "Niveshaay Team", contentUrl: input.contentUrl }, actor) : null,
    spacedWhatsApp(),
  ]);
  return { email, whatsapp };
}
