/**
 * Background worker (production/staging). Requires REDIS_URL.
 *   npm run worker
 * Processes campaign execution, WhatsApp sends, email dispatch/reconciliation, CRM sync,
 * webhook retries, and a once-a-minute scheduler tick.
 */
import "dotenv/config";
import { Worker, Queue } from "bullmq";
import { QUEUE_NAME, type JobName } from "../src/lib/queue";
import { runJob } from "../src/lib/queue/jobs";

if (!process.env.REDIS_URL) {
  console.error("REDIS_URL is required for the worker. In local development the app uses the inline queue instead.");
  process.exit(1);
}
const connection = { url: process.env.REDIS_URL, maxRetriesPerRequest: null };
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 5);

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    await runJob(job.name as JobName, job.data);
  },
  { connection, concurrency },
);

worker.on("failed", (job, err) => console.error(`[worker] ${job?.name} ${job?.id} failed: ${err.message}`));
worker.on("ready", () => console.log(`[worker] ready (concurrency ${concurrency}, live send ${process.env.ALLOW_LIVE_SEND === "true" ? "ENABLED" : "disabled"})`));

const queue = new Queue(QUEUE_NAME, { connection });
queue
  .upsertJobScheduler("scheduler-tick", { every: 60_000 }, { name: "scheduler.tick", data: {} })
  .catch((e) => console.error("[worker] could not register scheduler tick", e));

const shutdown = async () => {
  console.log("[worker] shutting down…");
  await worker.close();
  await queue.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
