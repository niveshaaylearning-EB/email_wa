/**
 * Provider adapter contracts. Each provider has a real adapter (verified against official
 * docs — see docs/integrations.md) and a MOCK adapter that simulates behaviour and marks
 * everything it produces as simulated. Orchestration code depends only on these interfaces.
 */

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  accountInfo?: Record<string, unknown>;
  latencyMs?: number;
}

// ─── Zoho CRM ──────────────────────────────────────────────────────────

export interface CrmContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  secondaryEmail: string | null;
  phone: string | null;
  mobile: string | null;
  emailOptOut: boolean;
  modifiedTime: string | null; // ISO
  owner: string | null;
  city: string | null;
  status: string | null;
  extra: Record<string, unknown>;
}

export interface CrmPage {
  records: CrmContact[];
  nextPageToken: string | null;
  moreRecords: boolean;
}

export interface CrmDeletedPage {
  deleted: { id: string; deletedTime: string | null }[];
  moreRecords: boolean;
}

export interface CrmProvider {
  readonly kind: "real" | "mock";
  testConnection(): Promise<ConnectionTestResult>;
  /** Paginated (page_token) retrieval sorted by Modified_Time asc. */
  fetchContacts(opts: { modifiedSince?: Date | null; pageToken?: string | null; perPage?: number }): Promise<CrmPage>;
  fetchDeleted(opts: { since?: Date | null; page: number }): Promise<CrmDeletedPage>;
}

// ─── Zoho Marketing Automation ─────────────────────────────────────────

export interface EmailCampaignReport {
  sent: number | null;
  delivered: number | null;
  opens: number | null;
  uniqueClicks: number | null;
  bounces: number | null;
  hardBounces: number | null;
  softBounces: number | null;
  unsubscribes: number | null;
  complaints: number | null;
  unsent: number | null;
  status: string | null;
  raw: Record<string, unknown>;
}

export type EmailRecipientAction =
  | "sentleads"
  | "openedleads"
  | "clickedleads"
  | "optoutleads"
  | "senthardbounce"
  | "sentsoftbounce"
  | "unsentleads";

export interface EmailCampaignProvider {
  readonly kind: "real" | "mock";
  testConnection(): Promise<ConnectionTestResult>;
  createList(name: string, firstEmails: string[], description?: string): Promise<{ listKey: string }>;
  /** Adds emails in provider-sized batches (Zoho MA: max 10 per call). */
  addEmailsToList(listKey: string, emails: string[]): Promise<{ added: number; failedBatches: { emails: string[]; error: string }[] }>;
  getListLeadCount(listKey: string): Promise<number | null>;
  createCampaign(input: {
    name: string;
    fromEmail: string;
    fromName?: string;
    subject: string;
    listKey: string;
    contentUrl: string;
    topicId?: string;
  }): Promise<{ campaignKey: string }>;
  sendCampaign(campaignKey: string): Promise<{ status: string | null }>;
  getCampaignReport(campaignKey: string): Promise<EmailCampaignReport>;
  getCampaignRecipients(campaignKey: string, action: EmailRecipientAction, fromIndex: number, range: number): Promise<{ email: string; time: string | null }[]>;
}

// ─── DoubleTick WhatsApp ───────────────────────────────────────────────

export interface WhatsAppSendInput {
  from: string; // E.164 with +
  to: string; // E.164 with +
  content: {
    templateName: string;
    language: string;
    templateData?: Record<string, unknown>;
  };
  customData: Record<string, string>;
}

export type WhatsAppSendOutcome =
  | { kind: "accepted"; providerStatus: "SENT" | "ENQUEUED"; messageId: string; httpStatus: number; raw: unknown }
  | { kind: "rejected"; providerStatus: "FAILED"; messageId: string | null; error: string; httpStatus: number; raw: unknown }
  | { kind: "http_error"; httpStatus: number; error: string; raw: unknown }
  | { kind: "network_error"; phase: "before_send" | "after_send"; error: string };

export interface WhatsAppStatus {
  messageId: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedAt: string | null;
  failedReason: string | null;
  errorCode: string | null;
}

export interface WhatsAppProvider {
  readonly kind: "real" | "mock";
  testConnection(): Promise<ConnectionTestResult>;
  sendTemplate(input: WhatsAppSendInput): Promise<WhatsAppSendOutcome>;
  getMessageStatus(messageId: string): Promise<WhatsAppStatus | null>;
}

export class LiveSendBlockedError extends Error {
  constructor(reason: string) {
    super(`Live send blocked: ${reason}`);
  }
}

export class ProviderError extends Error {
  constructor(
    public provider: string,
    message: string,
    public httpStatus?: number,
    public providerCode?: string,
    public retryable = false,
  ) {
    super(message);
  }
}
