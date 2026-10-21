/**
 * HARD SEND LOCK — instructed by the project owner on 2026-10-19:
 * "until further approval from me only send it to <owner>".
 *
 * No real WhatsApp message or email may be sent to anyone who is not on the approved lists —
 * regardless of test recipients, ALLOW_LIVE_SEND or provider mode. Enforced in the onboarding
 * trigger, the DoubleTick send adapter and the Zoho email paths.
 *
 * The approved numbers/emails are personal data, so they live in a local, git-ignored file:
 *   config/send-allowlist.local.json   (see config/send-allowlist.example.json)
 * Override the path with SEND_ALLOWLIST_FILE. If the file is missing or invalid, BOTH lists are
 * empty and every real send is blocked (fail closed).
 */
import fs from "node:fs";
import path from "node:path";

interface Allowlist {
  numbers: string[];
  emails: string[];
}

function allowlistPath() {
  return process.env.SEND_ALLOWLIST_FILE || path.join(process.cwd(), "config", "send-allowlist.local.json");
}

/** Read on every check (tiny file) so edits apply immediately and tests can swap files. */
export function loadAllowlist(): Allowlist {
  try {
    const raw = JSON.parse(fs.readFileSync(allowlistPath(), "utf8")) as Partial<Allowlist>;
    const numbers = Array.isArray(raw.numbers) ? raw.numbers.filter((n): n is string => typeof n === "string" && /^\+\d{8,15}$/.test(n.replace(/\s/g, ""))) : [];
    const emails = Array.isArray(raw.emails) ? raw.emails.filter((e): e is string => typeof e === "string" && e.includes("@")) : [];
    return { numbers: numbers.map((n) => n.replace(/\s/g, "")), emails: emails.map((e) => e.trim().toLowerCase()) };
  } catch {
    return { numbers: [], emails: [] }; // fail closed
  }
}

export function approvedRealSendNumbers(): readonly string[] {
  return loadAllowlist().numbers;
}

export function approvedRealSendEmails(): readonly string[] {
  return loadAllowlist().emails;
}

export function isApprovedRealSendNumber(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const digits = phone.replace(/\D/g, "");
  return approvedRealSendNumbers().some((n) => n.replace(/\D/g, "") === digits);
}

export function isApprovedRealSendEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return approvedRealSendEmails().includes(e);
}

export const SEND_LOCK_MESSAGE = "Blocked by the hard send lock: real WhatsApp messages may only go to the approved numbers in config/send-allowlist.local.json.";
export const EMAIL_LOCK_MESSAGE = "Blocked by the hard email lock: real emails may only go to the approved addresses in config/send-allowlist.local.json.";
