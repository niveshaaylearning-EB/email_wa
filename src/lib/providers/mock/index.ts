/**
 * MOCK adapters — used in development, tests and staging until real credentials are
 * configured. Everything they produce is flagged `isSimulated` and labelled in the UI.
 * They never contact any external service.
 */
import { randomUUID } from "node:crypto";
import type {
  CrmContact,
  CrmProvider,
  EmailCampaignProvider,
  EmailCampaignReport,
  WhatsAppProvider,
  WhatsAppSendInput,
  WhatsAppSendOutcome,
} from "../types";

// Deterministic PRNG so mock data is stable across runs.
export function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const FIRST = ["Aarav", "Vivaan", "Aditya", "Ishaan", "Riya", "Ananya", "Diya", "Kavya", "Rohan", "Meera", "Arjun", "Saanvi", "Kabir", "Nisha", "Dev", "Priya", "Harsh", "Pooja", "Neel", "Tara", "Kunal", "Sneha", "Yash", "Isha", "Manav", "Aisha", "Parth", "Zoya", "Rahul", "Shreya"];
const LAST = ["Shah", "Patel", "Mehta", "Desai", "Iyer", "Nair", "Reddy", "Gupta", "Joshi", "Kapoor", "Agarwal", "Bhatt", "Chopra", "Malhotra", "Trivedi", "Rao", "Kulkarni", "Sinha", "Pandya", "Jain"];
const CITIES = ["Ahmedabad", "Mumbai", "Bengaluru", "Pune", "Surat", "Delhi", "Hyderabad", "Chennai", "Vadodara", "Kolkata", "Dubai", "London", "Singapore"];
const STATUSES = ["Active", "Active", "Active", "Active", "Prospect", "Renewal Due", "Inactive"];
const PLANS = ["Premium", "Core", "Small Cap Focus", "Trial"];

/** Generates the mock CRM dataset (with deliberate data-quality issues for testing). */
export function generateMockCrmContacts(count = 240, seed = 42): CrmContact[] {
  const rnd = seeded(seed);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
  const out: CrmContact[] = [];
  for (let i = 1; i <= count; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const city = pick(CITIES);
    const intl = city === "Dubai" ? "+9715" : city === "London" ? "+447" : city === "Singapore" ? "+658" : null;
    let mobile: string | null = intl
      ? `${intl}${String(Math.floor(rnd() * 1e7)).padStart(city === "London" ? 9 : 7, "0")}`
      : `9${String(Math.floor(rnd() * 1e9)).padStart(9, "0")}`;
    let email: string | null = `${first}.${last}${i}@example.com`.toLowerCase();
    const r = rnd();
    if (r < 0.06) email = null; // missing email
    else if (r < 0.1) mobile = null; // missing phone
    else if (r < 0.12) mobile = "12345"; // invalid phone
    const modified = new Date(Date.UTC(2026, 8, 1) + Math.floor(rnd() * 40 * 86400_000));
    out.push({
      id: `MOCK-${String(5_000_000_000 + i)}`,
      firstName: first,
      lastName: last,
      fullName: `${first} ${last}`,
      email,
      secondaryEmail: null,
      phone: null,
      mobile,
      emailOptOut: rnd() < 0.04,
      modifiedTime: modified.toISOString(),
      owner: pick(["Riya Shah", "Karan Mehta", "Advisory Desk"]),
      city,
      status: pick(STATUSES),
      extra: { Plan: pick(PLANS), Risk_Profile: pick(["Conservative", "Moderate", "Aggressive"]) },
    });
  }
  // Deliberate duplicate identity: two CRM records sharing one email + phone.
  if (out.length > 10) {
    out.push({ ...out[3], id: `MOCK-${5_000_000_000 + count + 1}`, fullName: `${out[3].fullName} (dup)`, modifiedTime: new Date().toISOString() });
  }
  return out;
}

export class MockCrmAdapter implements CrmProvider {
  readonly kind = "mock" as const;
  constructor(private contacts = generateMockCrmContacts()) {}
  async testConnection() {
    return { ok: true, message: "Mock CRM adapter — no external connection (simulated data).", accountInfo: { mock: true, records: this.contacts.length } };
  }
  async fetchContacts(opts: { modifiedSince?: Date | null; pageToken?: string | null; perPage?: number }) {
    const per = Math.min(200, opts.perPage ?? 200);
    const sorted = this.contacts
      .filter((c) => !opts.modifiedSince || new Date(c.modifiedTime ?? 0) > opts.modifiedSince)
      .sort((a, b) => (a.modifiedTime ?? "").localeCompare(b.modifiedTime ?? ""));
    const offset = opts.pageToken ? Number(opts.pageToken) : 0;
    const records = sorted.slice(offset, offset + per);
    const more = offset + per < sorted.length;
    return { records, nextPageToken: more ? String(offset + per) : null, moreRecords: more };
  }
  async fetchDeleted() {
    return { deleted: [], moreRecords: false };
  }
}

export class MockEmailAdapter implements EmailCampaignProvider {
  readonly kind = "mock" as const;
  private lists = new Map<string, Set<string>>();
  async testConnection() {
    return { ok: true, message: "Mock Zoho Marketing Automation adapter — nothing is sent.", accountInfo: { mock: true } };
  }
  async createList(_name: string, firstEmails: string[]) {
    const listKey = `mock-list-${randomUUID().slice(0, 8)}`;
    this.lists.set(listKey, new Set(firstEmails));
    return { listKey };
  }
  async addEmailsToList(listKey: string, emails: string[]) {
    const set = this.lists.get(listKey) ?? new Set();
    emails.forEach((e) => set.add(e));
    this.lists.set(listKey, set);
    return { added: emails.length, failedBatches: [] };
  }
  async getListLeadCount(listKey: string) {
    return this.lists.get(listKey)?.size ?? null;
  }
  async createCampaign() {
    return { campaignKey: `mock-campaign-${randomUUID().slice(0, 8)}` };
  }
  async sendCampaign() {
    return { status: "simulated" };
  }
  async getCampaignReport(): Promise<EmailCampaignReport> {
    return { sent: null, delivered: null, opens: null, uniqueClicks: null, bounces: null, hardBounces: null, softBounces: null, unsubscribes: null, complaints: null, unsent: null, status: "simulated", raw: { mock: true } };
  }
  async getCampaignRecipients() {
    return [];
  }
}

export class MockWhatsAppAdapter implements WhatsAppProvider {
  readonly kind = "mock" as const;
  constructor(private failureRate = 0.03) {}
  async testConnection() {
    return { ok: true, message: "Mock DoubleTick adapter — nothing is sent.", accountInfo: { mock: true } };
  }
  async sendTemplate(input: WhatsAppSendInput): Promise<WhatsAppSendOutcome> {
    if (input.to.replace(/\D/g, "").endsWith("0000")) {
      return { kind: "rejected", providerStatus: "FAILED", messageId: randomUUID(), error: "(simulated) Recipient is not a WhatsApp user", httpStatus: 201, raw: { simulated: true } };
    }
    if (Math.random() < this.failureRate) {
      return { kind: "http_error", httpStatus: 429, error: "(simulated) rate limited", raw: { simulated: true } };
    }
    return { kind: "accepted", providerStatus: "SENT", messageId: randomUUID(), httpStatus: 201, raw: { simulated: true } };
  }
  async getMessageStatus() {
    return null;
  }
}
