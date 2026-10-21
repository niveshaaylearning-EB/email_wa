"use client";

/** Typed browser → API helper. Adds the CSRF verification header and normalises errors. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined | null> } = {}): Promise<T> {
  const qs = init.query
    ? "?" + new URLSearchParams(Object.entries(init.query).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => [k, String(v)])).toString()
    : "";
  const res = await fetch(`${path}${qs}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", "x-ncc-request": "1" },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 401 && typeof window !== "undefined" && !path.startsWith("/api/auth")) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json?.error ?? {};
    throw new ApiError(res.status, e.code ?? "ERROR", e.message ?? `Request failed (${res.status})`, e.details);
  }
  return json.data as T;
}

/** Human-readable error text, including validation issue details when present. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const d = err.details as { errors?: string[] } | { path: string; message: string }[] | undefined;
    if (Array.isArray(d) && d.length) return `${err.message} ${d.map((x) => `${x.path ? x.path + ": " : ""}${x.message}`).join("; ")}`;
    if (d && !Array.isArray(d) && d.errors?.length) return `${err.message} ${d.errors.join(" ")}`;
    return err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
