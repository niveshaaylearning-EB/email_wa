// Used by run-niveshaay.bat. Waits until a TCP port accepts connections or a URL responds.
//   node scripts/wait-for.mjs tcp 5433 60          → exit 0 when localhost:5433 is open (60 s timeout)
//   node scripts/wait-for.mjs http http://localhost:3000/api/health 180
//   node scripts/wait-for.mjs open http://localhost:3000/api/health 240 http://localhost:3000  → wait, then open browser
//   node scripts/wait-for.mjs ensure-key            → fill CREDENTIALS_ENCRYPTION_KEY in .env if empty
import net from "node:net";
import fs from "node:fs";
import crypto from "node:crypto";
import { exec } from "node:child_process";

const [mode, target, timeoutArg] = process.argv.slice(2);
const deadline = Date.now() + Number(timeoutArg ?? 60) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tcpOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: Number(port) });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(1000, () => (s.destroy(), resolve(false)));
  });
}

async function httpOk(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

if (mode === "ensure-key") {
  const env = fs.readFileSync(".env", "utf8");
  if (/^CREDENTIALS_ENCRYPTION_KEY=\s*$/m.test(env)) {
    const key = crypto.randomBytes(32).toString("base64");
    fs.writeFileSync(".env", env.replace(/^CREDENTIALS_ENCRYPTION_KEY=\s*$/m, `CREDENTIALS_ENCRYPTION_KEY=${key}`));
    console.log("Generated CREDENTIALS_ENCRYPTION_KEY in .env");
  }
  process.exit(0);
}

const check = mode === "tcp" ? () => tcpOpen(target) : () => httpOk(target);
while (Date.now() < deadline) {
  if (await check()) {
    if (mode === "open") exec(`start "" "${process.argv[5] ?? target}"`, () => process.exit(0));
    else process.exit(0);
    await sleep(5000);
    process.exit(0);
  }
  await sleep(1000);
}
process.exit(1);
