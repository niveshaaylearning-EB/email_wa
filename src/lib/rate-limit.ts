/**
 * Fixed-window rate limiter. In-memory per process; when REDIS_URL is configured the
 * counter is shared across instances via Redis INCR/PEXPIRE.
 */
import type IORedis from "ioredis";

const memory = new Map<string, { count: number; resetAt: number }>();
let redis: IORedis | null | undefined;

async function getRedis(): Promise<IORedis | null> {
  if (redis !== undefined) return redis;
  if (!process.env.REDIS_URL) return (redis = null);
  const { default: Redis } = await import("ioredis");
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: false });
  return redis;
}

export async function rateLimit(key: string, limit: number, windowMs: number): Promise<{ ok: boolean; remaining: number }> {
  const r = await getRedis().catch(() => null);
  if (r) {
    const k = `ncc:rl:${key}`;
    const count = await r.incr(k);
    if (count === 1) await r.pexpire(k, windowMs);
    return { ok: count <= limit, remaining: Math.max(0, limit - count) };
  }
  const now = Date.now();
  const entry = memory.get(key);
  if (!entry || entry.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + windowMs });
    if (memory.size > 10_000) for (const [k, v] of memory) if (v.resetAt <= now) memory.delete(k);
    return { ok: true, remaining: limit - 1 };
  }
  entry.count += 1;
  return { ok: entry.count <= limit, remaining: Math.max(0, limit - entry.count) };
}
