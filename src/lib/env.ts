import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(72).default(12),
  ALLOW_LIVE_SEND: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  LIVE_SEND_MAX_RECIPIENTS: z.coerce.number().int().min(1).default(5000),
  ZOHO_CLIENT_ID: z.string().optional(),
  ZOHO_CLIENT_SECRET: z.string().optional(),
  ZOHO_REDIRECT_URI: z.string().optional(),
  ZOHO_DC: z.string().default("in"),
  DOUBLETICK_API_KEY: z.string().optional(),
  DOUBLETICK_SENDER_NUMBER: z.string().optional(),
  DOUBLETICK_WEBHOOK_SECRET: z.string().optional(),
  // TEST MODULE — DoubleTick onboarding bot trigger (see docs/doubletick-onboarding-test.md; remove after testing)
  DOUBLETICK_ONBOARDING_WEBHOOK_URL: z.string().optional(),
  DOUBLETICK_ONBOARDING_AUTH_KEY: z.string().optional(),
  // Salesforce archive
  ARCHIVE_STORAGE_DIR: z.string().optional(),
  /** Optional dedicated 32-byte base64 key for archive objects; derived from CREDENTIALS_ENCRYPTION_KEY when unset. */
  ARCHIVE_ENCRYPTION_KEY: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined))
    .refine((v) => v === undefined || Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded"),
  /** SIMULATED Salesforce connections (synthetic data). Always refused when NODE_ENV=production. */
  SFMC_ALLOW_SIMULATED: z
    .string()
    .optional()
    .transform((v) => v !== "false"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test hook: forget cached env so tests can mutate process.env. */
export function resetEnvCache() {
  cached = undefined;
}
