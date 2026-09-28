import "server-only";
import { Queue } from "bullmq";
import { AppError, ANALYSIS_QUEUE_NAME, type AnalysisJob } from "@pd/shared";
import { getRedis } from "./redis";

const globalForQueue = globalThis as unknown as { __pdQueue?: Queue<AnalysisJob> };

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
