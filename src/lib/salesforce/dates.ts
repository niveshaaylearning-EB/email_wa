/**
 * SFMC timestamps. SOAP objects frequently return wall-clock values without a UTC offset
 * (e.g. "2025-03-05T10:15:23.07"). Marketing Cloud system time is widely reported as CST
 * (UTC−06:00, no daylight saving), but this is a per-connection setting
 * (settings.sourceUtcOffset) because it must be confirmed for each tenant. The original
 * string is always stored next to the parsed value, and reports state which offset was assumed.
 */
export const DEFAULT_SOURCE_UTC_OFFSET = "-06:00";

const OFFSET_RE = /^[+-]\d{2}:\d{2}$/;
const HAS_ZONE_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const ISO_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?$/;
const US_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))? ?(AM|PM)?)?$/i;

export function isValidOffset(offset: string): boolean {
  return OFFSET_RE.test(offset);
}

function offsetMinutes(offset: string): number {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h, m] = offset.slice(1).split(":").map(Number);
  return sign * (h * 60 + m);
}

/** Parse an SFMC date string. Returns null for empty/unparseable input (never guesses). */
export function parseSfmcDate(raw: string | null | undefined, sourceOffset = DEFAULT_SOURCE_UTC_OFFSET): Date | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  if (HAS_ZONE_RE.test(s) && /^\d{4}-\d{2}-\d{2}T/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  let parts: number[] | null = null;
  const iso = ISO_LOCAL_RE.exec(s);
  if (iso) {
    const ms = iso[7] ? Math.round(Number(iso[7]) * 1000) : 0;
    parts = [Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4] ?? 0), Number(iso[5] ?? 0), Number(iso[6] ?? 0), ms];
  } else {
    const us = US_RE.exec(s);
    if (us) {
      let hour = Number(us[4] ?? 0);
      const ampm = us[7]?.toUpperCase();
      if (ampm === "PM" && hour < 12) hour += 12;
      if (ampm === "AM" && hour === 12) hour = 0;
      parts = [Number(us[3]), Number(us[1]), Number(us[2]), hour, Number(us[5] ?? 0), Number(us[6] ?? 0), 0];
    }
  }
  if (!parts) return null;
  const [y, mo, d, h, mi, se, ms] = parts;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
  const utc = Date.UTC(y, mo - 1, d, h, mi, se, ms) - offsetMinutes(isValidOffset(sourceOffset) ? sourceOffset : DEFAULT_SOURCE_UTC_OFFSET) * 60_000;
  return new Date(utc);
}

/** Format a UTC instant as SFMC wall-clock time for SOAP DateValue filters. */
export function toSfmcDateValue(date: Date, sourceOffset = DEFAULT_SOURCE_UTC_OFFSET): string {
  const local = new Date(date.getTime() + offsetMinutes(isValidOffset(sourceOffset) ? sourceOffset : DEFAULT_SOURCE_UTC_OFFSET) * 60_000);
  return local.toISOString().slice(0, 19);
}
