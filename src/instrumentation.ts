/**
 * Next.js server start hook. Without Redis (local development) the inline queue runs inside
 * the Next.js process, so we start the once-a-minute scheduler tick here. With Redis, the
 * dedicated worker (`npm run worker`) owns scheduling.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.REDIS_URL || process.env.NODE_ENV === "test") return;
  const g = globalThis as unknown as { __nccScheduler?: NodeJS.Timeout };
  if (g.__nccScheduler) return;
  const { enqueue } = await import("./lib/queue");
  g.__nccScheduler = setInterval(() => {
    enqueue("scheduler.tick", {}).catch((e) => console.error("[scheduler] tick failed", e));
  }, 60_000);
  console.log("[ncc] inline queue + scheduler active (development mode, no Redis)");
}
