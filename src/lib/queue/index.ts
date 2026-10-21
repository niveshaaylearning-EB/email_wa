/**
 * Job queue abstraction.
 *   - REDIS_URL set   → BullMQ (production/staging). Jobs are executed by `npm run worker`.
 *   - REDIS_URL unset → in-process inline driver (local development & tests only).
 *
 * All job handlers are idempotent: state lives in PostgreSQL and every handler claims its
 * work with a conditional UPDATE, so a job that runs twice cannot double-send.
 */
import type { Queue } from "bullmq";

export type JobName =
  | "campaign.execute"
  | "wa.send"
  | "email.dispatch"
  | "email.reconcile"
  | "crm.sync"
  | "scheduler.tick"
  | "webhook.retry"
  | "mock.simulate"
  // Salesforce archive (read-only extraction from Salesforce Marketing Cloud)
  | "sfmc.backup.step"
  | "sfmc.reconcile";

export interface EnqueueOptions {
  delayMs?: number;
  jobId?: string;
  attempts?: number;
}

export const QUEUE_NAME = "ncc-jobs";

let bullQueue: Queue | null = null;
async function getBullQueue(): Promise<Queue> {
  if (bullQueue) return bullQueue;
  const { Queue } = await import("bullmq");
  bullQueue = new Queue(QUEUE_NAME, {
    connection: { url: process.env.REDIS_URL!, maxRetriesPerRequest: null },
    defaultJobOptions: { removeOnComplete: { age: 7 * 86400, count: 10_000 }, removeOnFail: { age: 30 * 86400 }, attempts: 3, backoff: { type: "exponential", delay: 5000 } },
  });
  return bullQueue;
}

export function queueDriver(): "bullmq" | "inline" {
  return process.env.REDIS_URL ? "bullmq" : "inline";
}

// ─── Inline driver ────────────────────────────────────────────────────

interface InlineJob {
  name: JobName;
  data: unknown;
  runAt: number;
  jobId?: string;
}
const inline = {
  mode: (process.env.NODE_ENV === "test" ? "manual" : "timer") as "manual" | "timer",
  pending: [] as InlineJob[],
  seenJobIds: new Map<string, number>(),
  running: new Set<Promise<void>>(),
};

export function setInlineMode(mode: "manual" | "timer") {
  inline.mode = mode;
}

async function runInline(job: InlineJob) {
  const { runJob } = await import("./jobs");
  try {
    await runJob(job.name, job.data);
  } catch (err) {
    console.error(`[queue:inline] job ${job.name} failed:`, (err as Error).message);
  }
}

/** Tests: run all queued jobs (ignoring delays) until the queue is empty. */
export async function drainInlineQueue(maxJobs = 100_000): Promise<number> {
  let ran = 0;
  while (inline.pending.length && ran < maxJobs) {
    inline.pending.sort((a, b) => a.runAt - b.runAt);
    const job = inline.pending.shift()!;
    await runInline(job);
    ran += 1;
  }
  return ran;
}

export function inlinePendingJobs() {
  return inline.pending.map((j) => ({ name: j.name, jobId: j.jobId, runAt: j.runAt }));
}

export function clearInlineQueue() {
  inline.pending = [];
  inline.seenJobIds.clear();
}

export async function enqueue(name: JobName, data: unknown, opts: EnqueueOptions = {}) {
  if (queueDriver() === "bullmq") {
    const q = await getBullQueue();
    await q.add(name, data, { delay: opts.delayMs, jobId: opts.jobId?.replace(/:/g, "_"), attempts: opts.attempts });
    return;
  }
  if (opts.jobId) {
    const seen = inline.seenJobIds.get(opts.jobId);
    if (seen && Date.now() - seen < 10 * 60_000) return; // de-duplicate like BullMQ jobId
    inline.seenJobIds.set(opts.jobId, Date.now());
  }
  const job: InlineJob = { name, data, runAt: Date.now() + (opts.delayMs ?? 0), jobId: opts.jobId };
  if (inline.mode === "manual") {
    inline.pending.push(job);
    return;
  }
  setTimeout(() => {
    const p = runInline(job).finally(() => inline.running.delete(p));
    inline.running.add(p);
  }, opts.delayMs ?? 0);
}
