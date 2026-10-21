// PII masking for logs, audit metadata and stored provider payloads.

export function maskEmail(email?: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(1, local.length - visible.length))}@${domain}`;
}

export function maskPhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 6) return "****";
  return `${phone.trim().startsWith("+") ? "+" : ""}${digits.slice(0, 2)}${"*".repeat(digits.length - 6)}${digits.slice(-4)}`;
}

export function maskSecret(secret?: string | null): string | null {
  if (!secret) return null;
  if (secret.length <= 8) return "••••";
  return `••••${secret.slice(-4)}`;
}

const SECRET_KEYS = /(token|secret|password|authorization|api[-_]?key|cookie|refresh)/i;
const EMAIL_KEYS = /(email|mail)$/i;
const PHONE_KEYS = /(phone|mobile|msisdn|^to$|^from$|recipient|wabaNumber)/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /\+?\d[\d\s-]{8,14}\d/g;

/** Deep-mask an arbitrary value. Secrets are fully redacted; emails/phones partially masked. */
export function maskDeep<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value
      .replace(EMAIL_RE, (m) => maskEmail(m) ?? "")
      .replace(PHONE_RE, (m) => maskPhone(m) ?? "") as T;
  }
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, depth + 1)) as T;
  if (typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(k)) out[k] = v ? "[REDACTED]" : v;
      else if (typeof v === "string" && EMAIL_KEYS.test(k)) out[k] = maskEmail(v);
      else if (typeof v === "string" && PHONE_KEYS.test(k)) out[k] = maskPhone(v);
      else out[k] = maskDeep(v, depth + 1);
    }
    return out as T;
  }
  return value;
}
