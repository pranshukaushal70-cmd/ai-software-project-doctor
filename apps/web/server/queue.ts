import "server-only";
import { Queue } from "bullmq";
import { AppError, ANALYSIS_QUEUE_NAME, ENGINEERING_QUEUE_NAME, type AnalysisJob, type EngineeringJob } from "@pd/shared";
import { getRedis } from "./redis";

const globalForQueue = globalThis as unknown as { __pdQueue?: Queue<AnalysisJob>; __pdEngineeringQueue?: Queue<EngineeringJob> };

function getQueue(): Queue<AnalysisJob> {
  if (!globalForQueue.__pdQueue) {
    const connection = getRedis();
    if (!connection) throw new AppError("INTERNAL_ERROR", "Job queue is not configured");
    globalForQueue.__pdQueue = new Queue<AnalysisJob>(ANALYSIS_QUEUE_NAME, { connection });
  }
  return globalForQueue.__pdQueue;
}

export async function enqueueAnalysis(analysisId: string): Promise<void> {
  await getQueue().add(
    "analyze",
    { analysisId },
    {
      jobId: analysisId, // idempotent: enqueueing twice does not run twice
      attempts: 1,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  );
}

function getEngineeringQueue(): Queue<EngineeringJob> {
  if (!globalForQueue.__pdEngineeringQueue) {
    const connection = getRedis();
    if (!connection) throw new AppError("INTERNAL_ERROR", "Job queue is not configured");
    globalForQueue.__pdEngineeringQueue = new Queue<EngineeringJob>(ENGINEERING_QUEUE_NAME, { connection });
  }
  return globalForQueue.__pdEngineeringQueue;
}

/** Planner and code-engine jobs (Phase 8) run in the worker. Job ids make enqueueing the same job twice a no-op. */
export async function enqueueEngineering(job: EngineeringJob): Promise<void> {
  const jobId = job.type === "plan" ? `plan-${job.planId}` : `run-${job.runId}-${job.phase}`;
  await getEngineeringQueue().add(job.type, job, { jobId, attempts: 1, removeOnComplete: { count: 1000 }, removeOnFail: { count: 5000 } });
}
