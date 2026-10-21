/**
 * DoubleTick WhatsApp API adapter.
 * Docs: https://docs.doubletick.io/reference/outgoing-messages-whatsapp-template-v2  (POST /v2/whatsapp/message/template)
 *       https://docs.doubletick.io/reference/get-message-status                        (GET /whatsapp/message/status)
 *       https://docs.doubletick.io/docs/getting-started                                (Authorization header)
 *
 * Notes from verification:
 *   - V2 does not accept a client-supplied messageId and idempotency is not documented,
 *     so de-duplication is enforced on our side (per-assignment idempotency key + DB claim)
 *     and correlation uses `customData` (string values, echoed at the root of webhooks).
 *   - Response 201: { messages: [{ status: SENT|FAILED|ENQUEUED, recipient, messageId, errorMessage? }] }
 *   - Auth header style is inconsistent in the docs (raw key vs "key <apiKey>"); configurable.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { httpRequest, NetworkError } from "../http";
import { assertLiveSendAllowed, loadIntegration, recordProviderError, recordProviderSuccess } from "@/lib/services/integrations";
import { isApprovedRealSendNumber, SEND_LOCK_MESSAGE } from "@/lib/send-allowlist";
import type { ConnectionTestResult, WhatsAppProvider, WhatsAppSendInput, WhatsAppSendOutcome, WhatsAppStatus } from "../types";

interface V2Response {
  messages?: { status?: string; recipient?: string; messageId?: string; errorMessage?: string }[];
  message?: string;
  error?: string;
  statusCode?: number;
}

export class DoubleTickAdapter implements WhatsAppProvider {
  readonly kind = "real" as const;

  private async ctx() {
    const { config, secrets } = await loadIntegration("DOUBLETICK");
    if (!secrets.apiKey) throw new Error("DoubleTick API key is not configured.");
    const auth = config.authHeaderStyle === "key_prefix" ? `key ${secrets.apiKey}` : secrets.apiKey;
    return { base: config.baseUrl.replace(/\/$/, ""), headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json" } };
  }

  /**
   * Non-sending credential probe: query the status of a random (non-existent) message ID.
   * 404 ⇒ the key was accepted; 401 ⇒ invalid key. No message is ever sent.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const t0 = Date.now();
    try {
      const { base, headers } = await this.ctx();
      const res = await httpRequest<V2Response>(`${base}/whatsapp/message/status?messageId=${randomUUID()}`, { headers });
      const latencyMs = Date.now() - t0;
      if (res.status === 401 || res.status === 403) {
        await recordProviderError("DOUBLETICK", "API key rejected (401)");
        return { ok: false, message: "DoubleTick rejected the API key (401 Unauthorized). Check the key and the auth header style.", latencyMs };
      }
      if (res.status === 404 || res.ok) {
        await recordProviderSuccess("DOUBLETICK", { status: "CONNECTED", accountInfo: { probe: "message-status", httpStatus: res.status } });
        return { ok: true, message: "DoubleTick accepted the API key (verified via non-sending status probe).", latencyMs };
      }
      if (res.status === 429) return { ok: false, message: "Rate limited by DoubleTick — retry in a few seconds.", latencyMs };
      return { ok: false, message: `Unexpected response from DoubleTick: HTTP ${res.status}`, latencyMs };
    } catch (err) {
      await recordProviderError("DOUBLETICK", (err as Error).message);
      return { ok: false, message: (err as Error).message, latencyMs: Date.now() - t0 };
    }
  }

  async sendTemplate(input: WhatsAppSendInput): Promise<WhatsAppSendOutcome> {
    await assertLiveSendAllowed("DOUBLETICK");
    if (!isApprovedRealSendNumber(input.to)) throw new Error(SEND_LOCK_MESSAGE);
    const { base, headers } = await this.ctx();
    const body = {
      messages: [{ from: input.from, to: input.to, content: input.content, customData: input.customData }],
    };
    let res;
    try {
      res = await httpRequest<V2Response>(`${base}/v2/whatsapp/message/template`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        timeoutMs: 30_000,
      });
    } catch (err) {
      const phase = err instanceof NetworkError ? err.phase : "after_send";
      return { kind: "network_error", phase, error: (err as Error).message };
    }
    if (!res.ok) {
      await recordProviderError("DOUBLETICK", `send HTTP ${res.status}: ${res.json?.error ?? res.json?.message ?? ""}`);
      return { kind: "http_error", httpStatus: res.status, error: String(res.json?.error ?? res.json?.message ?? `HTTP ${res.status}`), raw: res.json };
    }
    await recordProviderSuccess("DOUBLETICK");
    const m = res.json?.messages?.[0];
    if (!m) return { kind: "http_error", httpStatus: res.status, error: "Provider response contained no message result", raw: res.json };
    if (m.status === "FAILED") {
      return { kind: "rejected", providerStatus: "FAILED", messageId: m.messageId ?? null, error: m.errorMessage ?? "Provider reported FAILED", httpStatus: res.status, raw: res.json };
    }
    if (!m.messageId) return { kind: "http_error", httpStatus: res.status, error: "Provider accepted but returned no messageId", raw: res.json };
    return { kind: "accepted", providerStatus: m.status === "ENQUEUED" ? "ENQUEUED" : "SENT", messageId: m.messageId, httpStatus: res.status, raw: res.json };
  }

  /** Rate-limited by DoubleTick to 1 req/s per org — use only for targeted reconciliation. */
  async getMessageStatus(messageId: string): Promise<WhatsAppStatus | null> {
    const { base, headers } = await this.ctx();
    const res = await httpRequest<Record<string, string | null>>(`${base}/whatsapp/message/status?messageId=${encodeURIComponent(messageId)}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok || !res.json) throw new Error(`Status lookup failed: HTTP ${res.status}`);
    const j = res.json;
    return {
      messageId,
      sentAt: j.sentAt ?? null,
      deliveredAt: j.deliveredAt ?? null,
      readAt: j.readAt ?? null,
      failedAt: j.failedAt ?? null,
      failedReason: j.failedReason ?? null,
      errorCode: j.errorCode ? String(j.errorCode) : null,
    };
  }
}
