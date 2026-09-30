import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { getPrisma } from "@pd/db";
import { ANALYSIS_QUEUE_NAME, analysisJobSchema, loadLimits } from "@pd/shared";
import { createLogger } from "@pd/shared/logger";
import { runAnalysis } from "./pipeline";

process.env.SERVICE_NAME ??= "worker";
const log = createLogger("worker");

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  log.fatal("REDIS_URL is not set");
  process.exit(1);
}

const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const prisma = getPrisma();
const limits = loadLimits();
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);

const worker = new Worker(
  ANALYSIS_QUEUE_NAME,
  async (job) => {
    const { analysisId } = analysisJobSchema.parse(job.data);
    await runAnalysis(analysisId, { prisma, limits, log: log.child({ jobId: job.id }) });
  },
  { connection, concurrency },
);

worker.on("ready", () => log.info({ queue: ANALYSIS_QUEUE_NAME, concurrency }, "worker ready"));
worker.on("failed", (job, err) => log.error({ jobId: job?.id, err }, "job failed"));
// Without these listeners a Redis outage surfaces as unhandled 'error' events; BullMQ reconnects on its own.
// While Redis is down, ioredis retries continuously and BullMQ re-emits every failure,
// so connection errors are logged at most every 30 s. Other worker errors are always logged.
let lastConnectionErrorAt = 0;
const onError = (source: string) => (err: Error) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
    if (Date.now() - lastConnectionErrorAt < 30_000) return;
    lastConnectionErrorAt = Date.now();
    log.warn({ source, code }, "redis unreachable; retrying");
    return;
  }
  log.error({ source, err }, "worker error");
};
worker.on("error", onError("worker"));
connection.on("error", onError("connection"));

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  await worker.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
