import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";

export interface NormalizedPhone {
  raw: string;
  e164: string | null;
  country: string | null;
  countryCode: string | null;
  valid: boolean;
}

/**
 * Normalize a phone number to E.164. Numbers without an international prefix are parsed
 * against `defaultCountry` (India by default). Invalid numbers are kept raw but flagged.
 */
export function normalizePhone(
  raw: string | null | undefined,
  defaultCountry: CountryCode = "IN",
): NormalizedPhone | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let candidate = trimmed.replace(/[^\d+]/g, "");
  if (candidate.startsWith("00")) candidate = `+${candidate.slice(2)}`;
  let parsed = parsePhoneNumberFromString(candidate, defaultCountry);
  // CRM data frequently drops the "+" but keeps the country code (e.g. 919876543210).
  if ((!parsed || !parsed.isValid()) && !candidate.startsWith("+") && candidate.length > 10) {
    parsed = parsePhoneNumberFromString(`+${candidate}`);
  }
  if (!parsed) return { raw: trimmed, e164: null, country: null, countryCode: null, valid: false };
  const valid = parsed.isValid();
  return {
    raw: trimmed,
    e164: valid ? parsed.number : null,
    country: parsed.country ?? null,
    countryCode: parsed.countryCallingCode ?? null,
    valid,
  };
}

/** DoubleTick webhook payloads omit "+"; compare on digits only. */
export function phoneDigits(phone: string | null | undefined): string {
  return (phone ?? "").replace(/\D/g, "");
}

export function formatPhoneInternational(e164: string | null | undefined): string {
  if (!e164) return "—";
  const parsed = parsePhoneNumberFromString(e164);
  return parsed ? parsed.formatInternational() : e164;
}
