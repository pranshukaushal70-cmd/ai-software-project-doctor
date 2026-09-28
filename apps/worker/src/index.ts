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

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  await worker.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
