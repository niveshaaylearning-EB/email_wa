import { config } from "dotenv";

config({ path: ".env" });
(process.env as Record<string, string>).NODE_ENV = "test";
// Tests always run against the dedicated test database and can never send live messages.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/niveshaay_cc_test";
process.env.ALLOW_LIVE_SEND = "false";
process.env.REDIS_URL = "";
process.env.CREDENTIALS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.DOUBLETICK_WEBHOOK_SECRET = "test-webhook-secret";
// Never let tests see real provider credentials from .env.
process.env.DOUBLETICK_API_KEY = "";
// Fake recipients only — the real allowlist (config/send-allowlist.local.json) is never used in tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const allowlistFile = path.join(os.tmpdir(), "ncc-test-send-allowlist.json");
fs.writeFileSync(allowlistFile, JSON.stringify({ numbers: ["+919000000001"], emails: ["approved@example.com"] }));
process.env.SEND_ALLOWLIST_FILE = allowlistFile;
process.env.ZOHO_CLIENT_ID = "";
process.env.ZOHO_CLIENT_SECRET = "";
