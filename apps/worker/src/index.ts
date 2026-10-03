import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { createEditProvider, createProvider, type ProviderEnv } from "@pd/agent";
import { getPrisma } from "@pd/db";
import { executePlanJob, runEngineJob, scheduleStaleRunSweep } from "@pd/engine";
import { createSandbox, loadSandboxConfig } from "@pd/sandbox";
import { ANALYSIS_QUEUE_NAME, analysisJobSchema, ENGINEERING_QUEUE_NAME, engineeringJobSchema, loadLimits } from "@pd/shared";
import { createLogger } from "@pd/shared/logger";
import { runAnalysis } from "./pipeline";
import { scheduleUploadSweep } from "./uploads";

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

// Engineering planner and code engine (Phase 8). Credentials come from this process's environment only.
const providerEnv = (): ProviderEnv => ({ AI_PROVIDER: process.env.AI_PROVIDER, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL });
const sandboxConfig = loadSandboxConfig();
const sandbox = createSandbox(sandboxConfig);
const engineConcurrency = Number(process.env.ENGINE_CONCURRENCY ?? 1);
const engineeringWorker = new Worker(
  ENGINEERING_QUEUE_NAME,
  async (job) => {
    const data = engineeringJobSchema.parse(job.data);
    const jobLog = log.child({ jobId: job.id });
    if (data.type === "plan") await executePlanJob(data.planId, { prisma, log: jobLog, provider: () => createProvider(providerEnv()) });
    else await runEngineJob(data.runId, data.phase, { prisma, log: jobLog, limits, sandbox, sandboxConfig, editProvider: () => createEditProvider(providerEnv()) });
  },
  // Runs can take minutes (model calls, sandboxed tests); BullMQ renews the lock while the job is alive.
  { connection, concurrency: engineConcurrency, lockDuration: 120_000 },
);
engineeringWorker.on("ready", () => log.info({ queue: ENGINEERING_QUEUE_NAME, concurrency: engineConcurrency, sandbox: sandbox.name, install: sandboxConfig.installEnabled }, "engineering worker ready"));
engineeringWorker.on("failed", (job, err) => log.error({ jobId: job?.id, err }, "engineering job failed"));
const stopStaleRunSweep = scheduleStaleRunSweep(prisma, log);
// Uploaded archives are kept only while an analysis refers to them.
const stopUploadSweep = scheduleUploadSweep(prisma, limits.workspaceDir, log);
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
engineeringWorker.on("error", onError("engineering-worker"));
connection.on("error", onError("connection"));

async function shutdown(signal: string) {
  log.info({ signal }, "shutting down");
  stopUploadSweep();
  stopStaleRunSweep();
  await worker.close();
  await engineeringWorker.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
