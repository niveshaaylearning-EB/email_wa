/**
 * CSV encoding for archive exports.
 *
 * "safe" mode (default for spreadsheet use) neutralises formula injection by prefixing an
 * apostrophe to cells starting with = + - @ TAB or CR (OWASP guidance). This alters the
 * visible value, so every export also offers JSONL (exact values) and the CSV header row of
 * a safe export is followed by nothing else — the mode is recorded in the export audit log.
 * Values are never numerically converted; leading zeros survive in the file (spreadsheet
 * applications may still strip them on open — import as text, or use JSONL).
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: unknown, safe: boolean): string {
  if (value === null || value === undefined) return "";
  let s = value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);
  if (safe && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values: unknown[], safe: boolean): string {
  return values.map((v) => csvCell(v, safe)).join(",") + "\r\n";
}
