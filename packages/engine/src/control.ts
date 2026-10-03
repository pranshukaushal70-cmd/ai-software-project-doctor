import { access } from "node:fs/promises";
import { createEditProvider, ProviderError, type ProviderEnv } from "@pd/agent";
import { uploadPath } from "@pd/analyzer";
import { transitionRun, type Prisma, type PrismaClient } from "@pd/db";
import type { SandboxConfig, TestSetup } from "@pd/sandbox";
import {
  ACTIVE_RUN_STATUSES,
  AppError,
  ENGINEERING_RUN_LIMITS,
  type AnalyzerLimits,
  type EngineeringJob,
  type EngineeringRunInput,
  type EngineeringRunStatus,
  type ExecutionApproval,
} from "@pd/shared";
import type { Logger } from "@pd/shared/logger";

/**
 * The user's side of a code-engine run: start it for an approved plan, approve
 * (or skip) the sandboxed tests, cancel it, discard the result. Every operation
 * checks ownership (404 for anyone else's run) and moves the run only through
 * transitionRun, so the lifecycle and its approval gates hold. Nothing here
 * generates, runs or changes code: the worker does, from the queued jobs.
 */

export interface ControlDeps {
  prisma: PrismaClient;
  log: Logger;
  limits: Pick<AnalyzerLimits, "workspaceDir">;
  sandbox: Pick<SandboxConfig, "enabled" | "installEnabled">;
  /** AI provider settings (credentials only checked for presence here; the worker uses them). */
  env: ProviderEnv;
  enqueue(job: EngineeringJob): Promise<void>;
}

/** A run waits for the user or the worker: at most one such run per plan. */
const OPEN_STATUSES: EngineeringRunStatus[] = [...ACTIVE_RUN_STATUSES, "AWAITING_APPROVAL"];

export const RUN_SUMMARY_SELECT = {
  id: true,
  planId: true,
  status: true,
  provider: true,
  model: true,
  commitSha: true,
  maxIterations: true,
  tokenBudget: true,
  maxDurationSeconds: true,
  iteration: true,
  inputTokens: true,
  outputTokens: true,
  testCommand: true,
  installApproved: true,
  executionApprovedAt: true,
  cancelRequestedAt: true,
  failureReason: true,
  error: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
} satisfies Prisma.EngineeringRunSelect;

/** The run, if it belongs to the user (directly and through the plan's task and analysis); 404 otherwise. */
export async function ownedRun(prisma: PrismaClient, userId: string, runId: string) {
  const run = await prisma.engineeringRun.findFirst({
    where: { id: runId, userId, plan: { task: { userId, analysis: { repository: { userId } } } } },
    select: { ...RUN_SUMMARY_SELECT, testSetup: true },
  });
  if (!run) throw new AppError("NOT_FOUND", "Run not found");
  return run;
}

/** Starts a run for an approved plan: records it as QUEUED and queues its first job. */
export async function createRun(deps: ControlDeps, userId: string, planId: string, input: EngineeringRunInput = {}) {
  const { prisma } = deps;
  const plan = await prisma.engineeringPlan.findFirst({
    where: { id: planId, task: { userId, analysis: { repository: { userId } } } },
    select: { id: true, status: true, approvedAt: true, task: { select: { analysis: { select: { commitSha: true, repository: { select: { source: true, uploadKey: true } } } } } } },
  });
  if (!plan) throw new AppError("NOT_FOUND", "Plan not found");
  if (!plan.approvedAt || plan.status !== "COMPLETED") throw new AppError("CONFLICT", "Approve the plan before starting the code engine.");

  // The analysed source must be rebuildable (see materialize.ts); say so now rather than in a failed run.
  const { analysis } = plan.task;
  const repo = analysis.repository;
  if ((repo.source === "GITHUB" || repo.source === "GITLAB") && !analysis.commitSha) throw new AppError("CONFLICT", "This analysis did not record its commit; run a new analysis.");
  if (repo.source === "ZIP") {
    const stored = repo.uploadKey ? await access(uploadPath(deps.limits.workspaceDir, repo.uploadKey)).then(() => true, () => false) : false;
    if (!stored) throw new AppError("CONFLICT", "The uploaded archive of this analysis is no longer stored; upload the project again.");
  }

  let provider;
  try {
    provider = createEditProvider(deps.env);
  } catch (err) {
    if (err instanceof ProviderError) throw new AppError("CONFLICT", err.message);
    throw err;
  }

  const L = ENGINEERING_RUN_LIMITS;
  const run = await prisma
    .$transaction(
      async (tx) => {
        if ((await tx.engineeringRun.count({ where: { planId: plan.id, status: { in: OPEN_STATUSES } } })) > 0) {
          throw new AppError("CONFLICT", "This plan already has a run in progress or waiting for approval.");
        }
        const created = await tx.engineeringRun.create({
          data: {
            planId: plan.id,
            userId,
            provider: provider.name,
            model: provider.model,
            maxIterations: input.maxIterations ?? L.maxIterations.default,
            tokenBudget: input.tokenBudget ?? L.tokenBudget.default,
            maxDurationSeconds: input.maxDurationSeconds ?? L.maxDurationSeconds.default,
          },
          select: RUN_SUMMARY_SELECT,
        });
        await tx.engineeringRunEvent.create({ data: { runId: created.id, type: "created", actor: "user", toStatus: "QUEUED", message: "Run started for the approved plan." } });
        return created;
      },
      { isolationLevel: "Serializable" },
    )
    .catch((err: unknown) => {
      // Two concurrent starts: the serializable transaction lets only one through.
      if ((err as { code?: string }).code === "P2034") throw new AppError("CONFLICT", "This plan already has a run in progress or waiting for approval.");
      throw err;
    });

  await enqueueOrFail(deps, run.id, "QUEUED", { type: "run", runId: run.id, phase: "start" });
  deps.log.info({ runId: run.id, planId: plan.id, provider: provider.name, model: provider.model }, "run created");
  return run;
}

/** Second gate: the user approves running the shown test command (and, separately, the network-enabled install). */
export async function approveExecution(deps: ControlDeps, userId: string, runId: string, approval: ExecutionApproval) {
  const { prisma } = deps;
  const run = await ownedRun(prisma, userId, runId);
  if (run.status !== "AWAITING_APPROVAL") throw new AppError("CONFLICT", "This run is not waiting for approval.");
  const setup = run.testSetup as TestSetup | null;
  if (!setup) throw new AppError("CONFLICT", "This run has no test command to approve.");
  if (!deps.sandbox.enabled) throw new AppError("CONFLICT", "Sandboxed test runs are disabled on this server.");
  if (approval.install) {
    if (!deps.sandbox.installEnabled) throw new AppError("CONFLICT", "The dependency install step is disabled on this server.");
    if (!setup.install) throw new AppError("CONFLICT", "This test setup has no install step.");
  }
  const to: EngineeringRunStatus = approval.install ? "INSTALLING" : "TESTING";
  const moved = await transitionRun(prisma, runId, {
    from: "AWAITING_APPROVAL",
    to,
    actor: "user",
    message: approval.install ? `Approved: install dependencies (${setup.install!.display}) and run ${setup.test.display}.` : `Approved: run ${setup.test.display}.`,
    patch: { executionApprovedAt: new Date(), installApproved: approval.install, testCommand: setup.test.id },
    data: { install: approval.install ? setup.install!.id : null, test: setup.test.id, image: setup.image },
  });
  if (!moved) throw new AppError("CONFLICT", "The run changed in the meantime; reload it.");
  await enqueueOrFail(deps, runId, to, { type: "run", runId, phase: "execute" });
  return ownedRun(prisma, userId, runId);
}

/** The user skips the tests: the run goes to review with its diff, nothing executed. */
export async function skipExecution(deps: ControlDeps, userId: string, runId: string) {
  const run = await ownedRun(deps.prisma, userId, runId);
  if (run.status !== "AWAITING_APPROVAL") throw new AppError("CONFLICT", "This run is not waiting for approval.");
  const moved = await transitionRun(deps.prisma, runId, { from: "AWAITING_APPROVAL", to: "READY_FOR_REVIEW", actor: "user", message: "Tests skipped by the user; nothing was executed." });
  if (!moved) throw new AppError("CONFLICT", "The run changed in the meantime; reload it.");
  return ownedRun(deps.prisma, userId, runId);
}

/**
 * Cancels a run. A run waiting for the worker's queue or for the user stops at once;
 * a run the worker is processing is flagged and stops at the worker's next step.
 */
export async function cancelRun(deps: ControlDeps, userId: string, runId: string) {
  const { prisma } = deps;
  const run = await ownedRun(prisma, userId, runId);
  if (run.status === "QUEUED" || run.status === "AWAITING_APPROVAL") {
    const moved = await transitionRun(prisma, runId, { from: run.status, to: "CANCELLED", actor: "user", message: "Cancelled by the user." });
    if (moved) return ownedRun(prisma, userId, runId);
  }
  const current = await ownedRun(prisma, userId, runId);
  if (!ACTIVE_RUN_STATUSES.includes(current.status)) throw new AppError("CONFLICT", "This run can no longer be cancelled.");
  const flagged = await prisma.engineeringRun.updateMany({ where: { id: runId, status: { in: [...ACTIVE_RUN_STATUSES] }, cancelRequestedAt: null }, data: { cancelRequestedAt: new Date() } });
  if (flagged.count) await prisma.engineeringRunEvent.create({ data: { runId, type: "cancel-requested", actor: "user", message: "Cancellation requested; the worker stops at its next step." } });
  return ownedRun(prisma, userId, runId);
}

/** Discards a result: the run ends and the stored code (patch and per-change diffs) is deleted. */
export async function discardRun(deps: ControlDeps, userId: string, runId: string) {
  const { prisma } = deps;
  const run = await ownedRun(prisma, userId, runId);
  if (run.status !== "READY_FOR_REVIEW") throw new AppError("CONFLICT", "Only a run ready for review can be discarded.");
  const moved = await transitionRun(prisma, runId, { from: "READY_FOR_REVIEW", to: "DISCARDED", actor: "user", message: "Result discarded by the user.", patch: { patch: null } });
  if (!moved) throw new AppError("CONFLICT", "The run changed in the meantime; reload it.");
  await prisma.engineeringChange.updateMany({ where: { runId }, data: { diff: null } });
  return ownedRun(prisma, userId, runId);
}

async function enqueueOrFail(deps: ControlDeps, runId: string, from: EngineeringRunStatus, job: EngineeringJob) {
  try {
    await deps.enqueue(job);
  } catch (err) {
    await transitionRun(deps.prisma, runId, { from, to: "FAILED", actor: "worker", message: "Could not queue the run.", patch: { failureReason: "queue-error", error: "Could not queue the run. Please try again." } }).catch(() => undefined);
    throw err;
  }
}
