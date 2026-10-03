import { transitionRun, type PrismaClient } from "@pd/db";
import { ACTIVE_RUN_STATUSES } from "@pd/shared";
import type { Logger } from "@pd/shared/logger";

/**
 * Runs the worker is processing always make progress within their time budget.
 * A run that has been in a worker status for longer than its budget plus a margin
 * lost its job (a worker crash or restart) and is failed here, so the user is not
 * left watching a run that will never finish. Runs waiting for the user are never
 * swept.
 */

const MARGIN_MS = 10 * 60 * 1000;
export const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export async function sweepStaleRuns(prisma: PrismaClient, now = Date.now()): Promise<number> {
  const runs = await prisma.engineeringRun.findMany({
    where: { status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true, status: true, updatedAt: true, maxDurationSeconds: true },
    take: 500,
  });
  let failed = 0;
  for (const r of runs) {
    if (now - r.updatedAt.getTime() < r.maxDurationSeconds * 1000 + MARGIN_MS) continue;
    const message = "The run stopped making progress (the worker may have restarted). Start a new run.";
    if (await transitionRun(prisma, r.id, { from: r.status, to: "FAILED", actor: "worker", message, patch: { failureReason: "timeout", error: message } })) failed++;
  }
  return failed;
}

/** Sweeps now and every STALE_SWEEP_INTERVAL_MS; returns a function that stops it. */
export function scheduleStaleRunSweep(prisma: PrismaClient, log: Logger): () => void {
  const run = () =>
    sweepStaleRuns(prisma)
      .then((n) => {
        if (n) log.warn({ failed: n }, "failed stale engineering runs");
      })
      .catch((err) => log.warn({ err }, "stale run sweep failed"));
  void run();
  const timer = setInterval(run, STALE_SWEEP_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
