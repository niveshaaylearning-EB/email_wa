/**
 * Archive object store for raw Salesforce payloads, original content files, manifests and
 * evidence packages.
 *
 * Local driver (the only driver implemented today):
 *   - Root: ARCHIVE_STORAGE_DIR, default ~/.niveshaay-cc/archive — deliberately OUTSIDE the
 *     OneDrive-synced project folder, like the embedded database.
 *   - Each object is gzip-compressed (optional) then encrypted with AES-256-GCM using
 *     ARCHIVE_ENCRYPTION_KEY or a key derived (HKDF) from CREDENTIALS_ENCRYPTION_KEY.
 *     File format: "NCCA1" | gzipFlag(1) | iv(12) | tag(16) | ciphertext.
 *   - Write-once: an existing key is never overwritten. Re-writing identical content is an
 *     idempotent no-op; different content under the same key is an error.
 *   - SHA-256 is computed over the original (plaintext, uncompressed) bytes and stored in
 *     PostgreSQL, so integrity can be re-verified independently of the encryption layer.
 *
 * A production deployment should place this directory on encrypted, backed-up storage, or
 * add an S3-compatible driver with object lock (see docs/salesforce-archive.md).
 */
import "server-only";
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAGIC = Buffer.from("NCCA1");

export function archiveRoot(): string {
  return process.env.ARCHIVE_STORAGE_DIR || path.join(os.homedir(), ".niveshaay-cc", process.env.NODE_ENV === "test" ? "archive-test" : "archive");
}

function archiveKey(): Buffer {
  const dedicated = process.env.ARCHIVE_ENCRYPTION_KEY;
  if (dedicated) return Buffer.from(dedicated, "base64");
  const base = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!base) throw new Error("CREDENTIALS_ENCRYPTION_KEY is not set");
  return Buffer.from(hkdfSync("sha256", Buffer.from(base, "base64"), Buffer.from("ncc-archive"), Buffer.from("ncc-archive-objects-v1"), 32));
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Storage keys are relative, slash-separated, and restricted to a safe alphabet. */
export function assertSafeKey(key: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]{0,400}$/.test(key) || key.includes("..") || key.includes("//")) {
    throw new Error(`Unsafe archive storage key: ${key}`);
  }
}

function fullPath(key: string): string {
  assertSafeKey(key);
  // The archive root is outside the project (runtime data), so exclude it from output file tracing.
  const root = path.resolve(/*turbopackIgnore: true*/ archiveRoot());
  const p = path.resolve(/*turbopackIgnore: true*/ root, key);
  if (!p.startsWith(root + path.sep)) throw new Error("Archive key escapes the storage root");
  return p;
}

export interface StoredObject {
  storageKey: string;
  sha256: string;
  bytes: number;
  storedBytes: number;
}

function encode(data: Buffer, gzip: boolean): Buffer {
  const payload = gzip ? gzipSync(data, { level: 6 }) : data;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", archiveKey(), iv);
  const ct = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([gzip ? 1 : 0]), iv, cipher.getAuthTag(), ct]);
}

function decode(buf: Buffer): Buffer {
  if (buf.length < MAGIC.length + 1 + 12 + 16 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not an archive object (bad header)");
  let o = MAGIC.length;
  const gz = buf[o] === 1;
  o += 1;
  const iv = buf.subarray(o, o + 12);
  o += 12;
  const tag = buf.subarray(o, o + 16);
  o += 16;
  const decipher = createDecipheriv("aes-256-gcm", archiveKey(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(buf.subarray(o)), decipher.final()]);
  return gz ? gunzipSync(pt) : pt;
}

export async function putObject(key: string, data: Buffer | string, opts: { gzip?: boolean } = {}): Promise<StoredObject> {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const sha = sha256Hex(buf);
  const file = fullPath(key);
  if (fs.existsSync(file)) {
    const existing = await getObject(key);
    if (sha256Hex(existing) !== sha) throw new Error(`Archive object ${key} already exists with different content (write-once)`);
    return { storageKey: key, sha256: sha, bytes: buf.length, storedBytes: fs.statSync(file).size };
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const enc = encode(buf, opts.gzip ?? true);
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, enc, { mode: 0o600 });
  await fs.promises.rename(tmp, file);
  return { storageKey: key, sha256: sha, bytes: buf.length, storedBytes: enc.length };
}

export async function getObject(key: string): Promise<Buffer> {
  return decode(await fs.promises.readFile(fullPath(key)));
}

export async function objectExists(key: string): Promise<boolean> {
  return fs.existsSync(fullPath(key));
}

/** Re-read, decrypt (GCM tag check) and re-hash an object. */
export async function verifyObject(key: string, expectedSha256: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const data = await getObject(key);
    const sha = sha256Hex(data);
    return sha === expectedSha256 ? { ok: true } : { ok: false, reason: `hash mismatch (expected ${expectedSha256.slice(0, 12)}…, got ${sha.slice(0, 12)}…)` };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** Test helper: remove the test archive root. Refuses outside NODE_ENV=test. */
export async function clearTestArchive() {
  if (process.env.NODE_ENV !== "test") throw new Error("clearTestArchive is test-only");
  await fs.promises.rm(archiveRoot(), { recursive: true, force: true });
}
