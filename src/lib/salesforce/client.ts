/**
 * Salesforce Marketing Cloud Engagement read-only client.
 *
 * Auth: Installed Package "API Integration" with Server-to-Server (client_credentials) grant.
 *   POST {authBaseUri}/v2/token { grant_type, client_id, client_secret, account_id? }
 *   → { access_token, expires_in, scope, rest_instance_url, soap_instance_url }
 * The token is BU-scoped by account_id (MID). Tokens are cached in process memory only
 * (never persisted, never logged, never exported) and refreshed shortly before expires_in.
 *
 * Every request passes the read-only guard (readonly.ts), a per-connection concurrency
 * limiter and pacing interval, and bounded retries with exponential backoff for reads.
 */
import { createHash } from "node:crypto";
import { SfmcError, classifyMessage } from "./errors";
import { assertReadOnlyRequest } from "./readonly";
import { buildContinueEnvelope, buildRetrieveEnvelope, parseRetrieveResponse, type RetrievePage, type RetrieveParams } from "./soap";

export interface SfmcSettings {
  /** Parallel requests per connection in this process. */
  maxConcurrent: number;
  /** Minimum gap between request starts per connection (pacing). */
  minIntervalMs: number;
  /** Retries for retryable failures (429/5xx/network) on idempotent calls. */
  maxRetries: number;
  timeoutMs: number;
}

export const DEFAULT_SFMC_SETTINGS: SfmcSettings = { maxConcurrent: 2, minIntervalMs: 250, maxRetries: 5, timeoutMs: 120_000 };

export interface SfmcClientConfig {
  connectionId: string;
  authBaseUri: string;
  clientId: string;
  clientSecret: string;
  /** Business Unit MID passed as account_id. Omit to use the package's home BU. */
  mid?: string | null;
  restBaseUri?: string | null;
  soapBaseUri?: string | null;
  settings?: Partial<SfmcSettings>;
  fetchImpl?: typeof fetch;
  /** Metrics hook (no payloads, no secrets). */
  onCall?: (info: { channel: "auth" | "soap" | "rest"; status: number | null; ms: number; retry: number }) => void;
}

export interface TokenInfo {
  accessToken: string;
  expiresAt: number;
  scope: string[];
  restBaseUri: string;
  soapBaseUri: string;
}

export interface RawRetrievePage extends RetrievePage {
  raw: string;
  httpStatus: number;
}

// ─── Process-local token cache & limiter ──────────────────────────────

const tokenCache = new Map<string, TokenInfo>();
const limiters = new Map<string, { active: number; waiters: (() => void)[]; lastStart: number }>();

export function clearSfmcTokenCache(connectionId?: string) {
  for (const k of tokenCache.keys()) if (!connectionId || k.startsWith(`${connectionId}:`)) tokenCache.delete(k);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function backoff(attempt: number, retryAfterSec?: number): number {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, 120_000);
  const base = Math.min(60_000, 1000 * 2 ** (attempt - 1));
  return Math.round(base / 2 + Math.random() * (base / 2));
}

export function normalizeBaseUri(uri: string): string {
  let u = uri.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u);
  if (parsed.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname) && parsed.hostname !== "sfmc.simulated") {
    throw new SfmcError("request", "Salesforce base URIs must use HTTPS");
  }
  return `${parsed.origin}/`;
}

/** Only genuine Marketing Cloud hosts (or the in-process simulator) may receive credentials. */
export function assertSfmcHost(uri: string) {
  const host = new URL(uri).hostname;
  if (host === "sfmc.simulated") return;
  if (!/\.(auth|rest|soap)\.marketingcloudapis\.com$/i.test(host) && !/\.exacttarget\.com$/i.test(host)) {
    throw new SfmcError("request", `Refusing to send credentials to non-Marketing Cloud host ${host}`);
  }
}

export class SfmcClient {
  readonly settings: SfmcSettings;
  private readonly fetchImpl: typeof fetch;
  private readonly authBase: string;
  apiCalls = 0;
  retries = 0;

  constructor(private readonly cfg: SfmcClientConfig) {
    this.settings = { ...DEFAULT_SFMC_SETTINGS, ...(cfg.settings ?? {}) };
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.authBase = normalizeBaseUri(cfg.authBaseUri);
    assertSfmcHost(this.authBase);
  }

  get mid() {
    return this.cfg.mid ?? null;
  }

  private cacheKey() {
    const secretTag = createHash("sha256").update(`${this.cfg.clientId}:${this.cfg.clientSecret}`).digest("hex").slice(0, 12);
    return `${this.cfg.connectionId}:${this.cfg.mid ?? "home"}:${secretTag}`;
  }

  private async acquire(): Promise<() => void> {
    const key = this.cfg.connectionId;
    let l = limiters.get(key);
    if (!l) limiters.set(key, (l = { active: 0, waiters: [], lastStart: 0 }));
    const lim = l;
    if (lim.active >= this.settings.maxConcurrent) await new Promise<void>((r) => lim.waiters.push(r));
    lim.active += 1;
    const wait = lim.lastStart + this.settings.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lim.lastStart = Date.now();
    return () => {
      lim.active -= 1;
      lim.waiters.shift()?.();
    };
  }

  private async rawFetch(channel: "auth" | "soap" | "rest", url: string, init: RequestInit, retry: number): Promise<{ status: number; text: string; headers: Headers }> {
    const release = await this.acquire();
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    let status: number | null = null;
    try {
      this.apiCalls += 1;
      const res = await this.fetchImpl(url, { ...init, signal: controller.signal, cache: "no-store" });
      status = res.status;
      const text = await res.text();
      return { status: res.status, text, headers: res.headers };
    } catch (err) {
      const e = err as { name?: string; message?: string; cause?: { code?: string } };
      const beforeSend = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(e.cause?.code ?? "");
      throw new SfmcError("network", e.name === "AbortError" ? "Request timed out" : `Network error: ${e.message ?? "unknown"}`, { code: beforeSend ? "BEFORE_SEND" : "AFTER_SEND" });
    } finally {
      clearTimeout(timer);
      release();
      this.cfg.onCall?.({ channel, status, ms: Date.now() - started, retry });
    }
  }

  // ─── Auth ───────────────────────────────────────────────────────────

  async getToken(force = false): Promise<TokenInfo> {
    const key = this.cacheKey();
    const cached = tokenCache.get(key);
    if (!force && cached && cached.expiresAt - 60_000 > Date.now()) return cached;
    const url = `${this.authBase}v2/token`;
    assertReadOnlyRequest({ channel: "auth", method: "POST", path: "/v2/token" });
    const body: Record<string, string> = { grant_type: "client_credentials", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret };
    if (this.cfg.mid) body.account_id = this.cfg.mid;
    let last: SfmcError | undefined;
    for (let attempt = 1; attempt <= this.settings.maxRetries; attempt++) {
      try {
        const res = await this.rawFetch("auth", url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, attempt - 1);
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(res.text) as Record<string, unknown>;
        } catch {
          /* non-JSON error page */
        }
        if (res.status >= 200 && res.status < 300 && typeof json.access_token === "string") {
          const expiresIn = Number(json.expires_in);
          const info: TokenInfo = {
            accessToken: json.access_token,
            expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 1000) * 1000,
            scope: typeof json.scope === "string" ? json.scope.split(/\s+/).filter(Boolean) : [],
            restBaseUri: normalizeBaseUri(this.cfg.restBaseUri || String(json.rest_instance_url ?? "")),
            soapBaseUri: normalizeBaseUri(this.cfg.soapBaseUri || String(json.soap_instance_url ?? "")),
          };
          assertSfmcHost(info.restBaseUri);
          assertSfmcHost(info.soapBaseUri);
          tokenCache.set(key, info);
          return info;
        }
        const msg = String(json.error_description ?? json.error ?? json.message ?? `HTTP ${res.status}`);
        const kind = res.status === 429 ? "rate_limit" : res.status >= 500 ? "server" : res.status === 401 || res.status === 400 ? "auth" : classifyMessage(msg, res.status);
        last = new SfmcError(kind, `Token request failed: ${msg}`, { httpStatus: res.status, code: typeof json.error === "string" ? json.error : undefined });
        if (!last.retryable) throw last;
        await sleep(backoff(attempt, Number(res.headers.get("retry-after"))));
      } catch (err) {
        if (!(err instanceof SfmcError) || !err.retryable || attempt === this.settings.maxRetries) throw err;
        last = err;
        this.retries += 1;
        await sleep(backoff(attempt));
      }
    }
    throw last ?? new SfmcError("auth", "Token request failed");
  }

  /** GET {auth}/v2/userinfo — account/org identifiers for the authenticated package. */
  async userInfo(): Promise<Record<string, unknown>> {
    const token = await this.getToken();
    assertReadOnlyRequest({ channel: "auth", method: "GET", path: "/v2/userinfo" });
    const res = await this.rawFetch("auth", `${this.authBase}v2/userinfo`, { method: "GET", headers: { Authorization: `Bearer ${token.accessToken}` } }, 0);
    if (res.status !== 200) throw new SfmcError(classifyMessage(res.text.slice(0, 300), res.status), `userinfo failed (HTTP ${res.status})`, { httpStatus: res.status });
    return JSON.parse(res.text) as Record<string, unknown>;
  }

  // ─── SOAP Retrieve ──────────────────────────────────────────────────

  private async soapCall(build: (soapUrl: string, token: string) => string, opts: { continuation: boolean; objectType?: string }): Promise<RawRetrievePage> {
    let authRetried = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.getToken();
      const soapUrl = `${token.soapBaseUri}Service.asmx`;
      const body = build(soapUrl, token.accessToken);
      assertReadOnlyRequest({ channel: "soap", method: "POST", soapAction: "Retrieve", body });
      try {
        const res = await this.rawFetch("soap", soapUrl, { method: "POST", headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "Retrieve" }, body }, attempt - 1);
        if (res.status === 429) throw new SfmcError("rate_limit", "SOAP API rate limited (HTTP 429)", { httpStatus: 429 });
        const page = parseRetrieveResponse(res.text, res.status);
        return { ...page, raw: res.text, httpStatus: res.status };
      } catch (err) {
        if (!(err instanceof SfmcError)) throw err;
        if (opts.objectType) err.details.objectType = opts.objectType;
        if (err.kind === "auth" && !authRetried) {
          authRetried = true;
          tokenCache.delete(this.cacheKey());
          continue; // a fresh token cannot have consumed the continuation
        }
        // A continuation batch can be consumed only once. If the request may have reached
        // Salesforce, retrying could silently skip a page — so the dataset must restart.
        if (opts.continuation && err.retryable && !(err.kind === "network" && err.details.code === "BEFORE_SEND")) {
          throw new SfmcError("continuation", `Continuation interrupted (${err.message}); the dataset will restart from page 1 to avoid gaps`, err.details);
        }
        if (!err.retryable || attempt >= this.settings.maxRetries) throw err;
        this.retries += 1;
        await sleep(backoff(attempt));
      }
    }
  }

  retrieve(params: RetrieveParams): Promise<RawRetrievePage> {
    return this.soapCall((url, token) => buildRetrieveEnvelope(url, token, params), { continuation: false, objectType: params.objectType });
  }

  continueRetrieve(requestId: string, objectType?: string): Promise<RawRetrievePage> {
    return this.soapCall((url, token) => buildContinueEnvelope(url, token, requestId), { continuation: true, objectType });
  }

  // ─── Published content files (public CDN, no credentials) ───────────

  /**
   * GET a published image/PDF. Only hosts on the caller's allow-list (derived from Content
   * Builder publishedURLs and Marketing Cloud CDNs) are fetched; no Authorization header is sent.
   */
  async fetchPublicFile(url: string, allowedHosts: Set<string>, maxBytes = 50 * 1024 * 1024): Promise<{ status: number; contentType: string | null; body: Buffer | null }> {
    assertReadOnlyRequest({ channel: "file", method: "GET", url });
    const host = new URL(url).hostname.toLowerCase();
    if (!allowedHosts.has(host)) throw new SfmcError("request", `Host ${host} is not an allowed content host`);
    const release = await this.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      this.apiCalls += 1;
      const res = await this.fetchImpl(url, { method: "GET", signal: controller.signal, cache: "no-store", redirect: "follow" });
      if (!res.ok) return { status: res.status, contentType: res.headers.get("content-type"), body: null };
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new SfmcError("request", `File larger than ${maxBytes} bytes`);
      return { status: res.status, contentType: res.headers.get("content-type"), body: buf };
    } catch (err) {
      if (err instanceof SfmcError) throw err;
      const e = err as { name?: string; message?: string };
      throw new SfmcError("network", e.name === "AbortError" ? "Request timed out" : `Network error: ${e.message ?? "unknown"}`);
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  // ─── REST (read-only allow-list) ────────────────────────────────────

  async rest<T = unknown>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {}): Promise<{ json: T; text: string; status: number }> {
    assertReadOnlyRequest({ channel: "rest", method, path });
    let authRetried = false;
    for (let attempt = 1; ; attempt++) {
      const token = await this.getToken();
      const qs = opts.query
        ? "?" + new URLSearchParams(Object.entries(opts.query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString()
        : "";
      const url = `${token.restBaseUri}${path.replace(/^\//, "")}${qs}`;
      try {
        const res = await this.rawFetch(
          "rest",
          url,
          { method, headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/json" }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined },
          attempt - 1,
        );
        if (res.status >= 200 && res.status < 300) return { json: (res.text ? JSON.parse(res.text) : null) as T, text: res.text, status: res.status };
        let msg = `HTTP ${res.status}`;
        try {
          const j = JSON.parse(res.text) as Record<string, unknown>;
          msg = String(j.message ?? j.errorcode ?? j.error ?? msg);
        } catch {
          /* ignore */
        }
        const kind = res.status === 404 ? "request" : classifyMessage(msg, res.status);
        const err = new SfmcError(kind, `REST ${method} ${path} failed: ${msg}`, { httpStatus: res.status });
        if (res.status === 429) {
          if (attempt >= this.settings.maxRetries) throw err;
          this.retries += 1;
          await sleep(backoff(attempt, Number(res.headers.get("retry-after"))));
          continue;
        }
        throw err;
      } catch (err) {
        if (!(err instanceof SfmcError)) throw err;
        if (err.kind === "auth" && !authRetried) {
          authRetried = true;
          tokenCache.delete(this.cacheKey());
          continue;
        }
        if (!err.retryable || attempt >= this.settings.maxRetries) throw err;
        this.retries += 1;
        await sleep(backoff(attempt));
      }
    }
  }
}
