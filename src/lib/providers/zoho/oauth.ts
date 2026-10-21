/**
 * Zoho OAuth 2.0 (server-based web client).
 * Docs: https://www.zoho.com/accounts/protocol/oauth/web-apps/authorization.html
 *       https://www.zoho.com/crm/developer/docs/api/v8/access-refresh.html
 *       https://www.zoho.com/crm/developer/docs/api/v8/refresh.html
 *       https://www.zoho.com/crm/developer/docs/api/v8/token-validity.html
 *
 * Constraints honoured:
 *   - access tokens live 1h; we refresh only when < 2 min remain (Zoho caps refreshes at 10 / 10 min)
 *   - concurrent refreshes are coalesced per provider
 *   - tokens are stored AES-256-GCM encrypted and never leave the server
 */
import "server-only";
import type { Provider } from "@prisma/client";
import { httpRequest } from "../http";
import { getDataCenter, isTrustedAccountsServer, isTrustedZohoApiDomain, ZOHO_CRM_SCOPES, ZOHO_MA_SCOPES } from "./dc";
import { loadIntegration, recordProviderError, saveSecrets, type ZohoSecrets } from "@/lib/services/integrations";
import { ProviderError } from "../types";
import { env } from "@/lib/env";

type ZohoProvider = Extract<Provider, "ZOHO_CRM" | "ZOHO_MA">;

export function buildAuthorizeUrl(provider: ZohoProvider, dcKey: string, clientId: string, state: string): string {
  const dc = getDataCenter(dcKey);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: (provider === "ZOHO_CRM" ? ZOHO_CRM_SCOPES : ZOHO_MA_SCOPES).join(","),
    redirect_uri: redirectUri(),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${dc.accounts}/oauth/v2/auth?${params.toString()}`;
}

export function redirectUri(): string {
  return env().ZOHO_REDIRECT_URI ?? `${env().APP_URL}/api/integrations/zoho/callback`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  api_domain?: string;
  expires_in?: number;
  error?: string;
}

export async function exchangeCode(provider: ZohoProvider, code: string, accountsServer: string) {
  if (!isTrustedAccountsServer(accountsServer)) throw new ProviderError("zoho", "Untrusted accounts-server in OAuth callback");
  const { secrets } = await loadIntegration(provider);
  if (!secrets.clientId || !secrets.clientSecret) throw new ProviderError("zoho", "Zoho client ID/secret are not configured");
  const res = await httpRequest<TokenResponse>(`${accountsServer}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: secrets.clientId,
      client_secret: secrets.clientSecret,
      redirect_uri: redirectUri(),
      code,
    }).toString(),
  });
  const t = res.json;
  if (!res.ok || !t?.access_token || t.error) {
    throw new ProviderError("zoho", `Token exchange failed: ${t?.error ?? res.status}`, res.status, t?.error);
  }
  if (!t.refresh_token) {
    throw new ProviderError("zoho", "Zoho did not return a refresh token. Ensure access_type=offline and prompt=consent, then reconnect.");
  }
  const apiDomain = t.api_domain && isTrustedZohoApiDomain(t.api_domain) ? t.api_domain : undefined;
  await saveSecrets(provider, {
    refreshToken: t.refresh_token,
    accessToken: t.access_token,
    accessTokenExpiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    accountsServer,
    apiDomain,
  } satisfies Partial<ZohoSecrets>);
}

const inflight = new Map<ZohoProvider, Promise<string>>();

/** Returns a valid access token, refreshing if needed. */
export async function getAccessToken(provider: ZohoProvider, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  const { secrets, config } = await loadIntegration(provider);
  if (!secrets.refreshToken) throw new ProviderError("zoho", "Zoho is not connected (no refresh token).");
  if (!opts.forceRefresh && secrets.accessToken && (secrets.accessTokenExpiresAt ?? 0) - Date.now() > 120_000) {
    return secrets.accessToken;
  }
  const existing = inflight.get(provider);
  if (existing) return existing;
  const p = (async () => {
    const accounts = secrets.accountsServer ?? getDataCenter(config.dc).accounts;
    const params = new URLSearchParams({
      refresh_token: secrets.refreshToken!,
      client_id: secrets.clientId ?? "",
      client_secret: secrets.clientSecret ?? "",
      grant_type: "refresh_token",
    });
    const res = await httpRequest<TokenResponse>(`${accounts}/oauth/v2/token?${params.toString()}`, { method: "POST" });
    const t = res.json;
    if (!res.ok || !t?.access_token) {
      const msg = `Zoho token refresh failed: ${t?.error ?? `HTTP ${res.status}`}`;
      await recordProviderError(provider, msg);
      throw new ProviderError("zoho", msg, res.status, t?.error, res.status >= 500);
    }
    await saveSecrets(provider, {
      accessToken: t.access_token,
      accessTokenExpiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
      ...(t.api_domain && isTrustedZohoApiDomain(t.api_domain) ? { apiDomain: t.api_domain } : {}),
    });
    return t.access_token;
  })().finally(() => inflight.delete(provider));
  inflight.set(provider, p);
  return p;
}

export async function revokeZoho(provider: ZohoProvider) {
  const { secrets, config } = await loadIntegration(provider);
  if (secrets.refreshToken) {
    const accounts = secrets.accountsServer ?? getDataCenter(config.dc).accounts;
    await httpRequest(`${accounts}/oauth/v2/token/revoke?token=${encodeURIComponent(secrets.refreshToken)}`, { method: "POST" }).catch(() => undefined);
  }
  await saveSecrets(provider, { refreshToken: "", accessToken: "", accessTokenExpiresAt: undefined, accountsServer: "", apiDomain: "" });
}

/**
 * Authorised request with one transparent retry on 401 (expired/invalidated token —
 * Zoho invalidates the oldest of >15 active access tokens per refresh token).
 */
export async function zohoFetch<T>(provider: ZohoProvider, url: string, init: RequestInit = {}) {
  const doFetch = async (token: string) =>
    httpRequest<T>(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Zoho-oauthtoken ${token}` } });
  let res = await doFetch(await getAccessToken(provider));
  if (res.status === 401) res = await doFetch(await getAccessToken(provider, { forceRefresh: true }));
  return res;
}
