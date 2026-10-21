// TEST MODULE — DoubleTick onboarding bot trigger. Remove after testing (docs/doubletick-onboarding-test.md).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { createClient, createUser, resetDb } from "../support/db";
import { resetEnvCache } from "@/lib/env";
import { triggerOnboarding } from "@/lib/services/onboarding-trigger";
import { ensureIntegration } from "@/lib/services/integrations";

const URL = "https://bothook.io/v1/public/triggers/webhooks/00000000-0000-4000-8000-000000000000";
let calls: { url: string; init: RequestInit }[] = [];

beforeEach(async () => {
  await resetDb();
  await ensureIntegration("DOUBLETICK");
  process.env.DOUBLETICK_ONBOARDING_WEBHOOK_URL = URL;
  process.env.DOUBLETICK_ONBOARDING_AUTH_KEY = "key_trigger_test";
  resetEnvCache();
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DOUBLETICK_ONBOARDING_WEBHOOK_URL;
  delete process.env.DOUBLETICK_ONBOARDING_AUTH_KEY;
  resetEnvCache();
});

describe("onboarding bot trigger (test module)", () => {
  it("preview builds the documented payload and makes no call", async () => {
    const admin = await createUser("ADMIN");
    const r = await prisma.internalTestRecipient.create({ data: { name: "Approved Tester", phoneE164: "+919000000001" } });
    const res = await triggerOnboarding({ testRecipientId: r.id, dryRun: true }, admin);
    expect(res.outcome).toBe("preview");
    expect(res.payload).toEqual({ customerPhone: "919000000001", customerName: "Approved Tester" });
    expect(calls).toHaveLength(0);
  });

  it("sends to a test recipient with the trigger key, then blocks a repeat within 10 minutes", async () => {
    const admin = await createUser("ADMIN");
    const r = await prisma.internalTestRecipient.create({ data: { name: "Approved Tester", phoneE164: "+919000000001" } });
    await expect(triggerOnboarding({ testRecipientId: r.id, dryRun: false }, admin)).rejects.toThrow(/Type SEND/);
    const res = await triggerOnboarding({ testRecipientId: r.id, dryRun: false, confirm: "SEND" }, admin);
    expect(res.outcome).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("key_trigger_test");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ customerPhone: "919000000001", customerName: "Approved Tester" });
    await expect(triggerOnboarding({ testRecipientId: r.id, dryRun: false, confirm: "SEND" }, admin)).rejects.toThrow(/already triggered/);
    expect(calls).toHaveLength(1);
  });

  it("hard send lock blocks any other test recipient number", async () => {
    const admin = await createUser("ADMIN");
    const other = await prisma.internalTestRecipient.create({ data: { name: "Someone Else", phoneE164: "+919800000101" } });
    await expect(triggerOnboarding({ testRecipientId: other.id, dryRun: false, confirm: "SEND" }, admin)).rejects.toThrow(/hard send lock/);
    expect(calls).toHaveLength(0);
  });

  it("never sends to real clients while live sending is off", async () => {
    const admin = await createUser("ADMIN");
    const c = await createClient();
    await expect(triggerOnboarding({ clientId: c.id, dryRun: false, confirm: "SEND" }, admin)).rejects.toThrow(/Real clients are blocked/);
    expect(calls).toHaveLength(0);
  });

  it("refuses without the trigger key or with a non-bothook URL", async () => {
    const admin = await createUser("ADMIN");
    const r = await prisma.internalTestRecipient.create({ data: { name: "Approved Tester", phoneE164: "+919000000001" } });
    process.env.DOUBLETICK_ONBOARDING_AUTH_KEY = "";
    process.env.DOUBLETICK_ONBOARDING_WEBHOOK_URL = "https://evil.example/hook";
    resetEnvCache();
    await expect(triggerOnboarding({ testRecipientId: r.id, dryRun: false, confirm: "SEND" }, admin)).rejects.toThrow(/Authorization Key is not set/);
    expect(calls).toHaveLength(0);
  });
});
