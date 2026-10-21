import { z } from "zod";

const emailSchema = z.email();

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return null;
  return emailSchema.safeParse(trimmed).success ? trimmed : null;
}

export function isValidEmail(email: string | null | undefined): boolean {
  return normalizeEmail(email) !== null;
}
