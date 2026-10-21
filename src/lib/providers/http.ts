import { backoffMs } from "@/lib/domain/delivery-status";

export interface HttpResult<T = unknown> {
  status: number;
  ok: boolean;
  json: T | null;
  text: string;
  headers: Headers;
}

export class NetworkError extends Error {
  constructor(
    message: string,
    /** before_send: connection never established; after_send: request may have reached the server */
    public phase: "before_send" | "after_send",
  ) {
    super(message);
  }
}

const BEFORE_SEND_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET_BEFORE", "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED"]);

export async function httpRequest<T = unknown>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<HttpResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
    const text = await res.text();
    let json: T | null = null;
    try {
      json = text ? (JSON.parse(text) as T) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, json, text, headers: res.headers };
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string }; message?: string };
    const code = e.cause?.code ?? "";
    if (e.name === "AbortError") throw new NetworkError("Request timed out", "after_send");
    throw new NetworkError(e.message ?? "Network error", BEFORE_SEND_CODES.has(code) ? "before_send" : "after_send");
  } finally {
    clearTimeout(timer);
  }
}

/** Retry wrapper for idempotent reads only (GET / report polling). */
export async function httpReadWithRetry<T = unknown>(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  attempts = 4,
): Promise<HttpResult<T>> {
  let last: HttpResult<T> | undefined;
  for (let i = 1; i <= attempts; i++) {
    try {
      last = await httpRequest<T>(url, init);
      if (last.status !== 429 && last.status < 500) return last;
    } catch (err) {
      if (i === attempts) throw err;
    }
    if (i < attempts) {
      const retryAfter = Number(last?.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(i, 500, 15_000)));
    }
  }
  return last!;
}
