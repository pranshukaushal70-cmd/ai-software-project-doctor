import "server-only";
import {
  approveExecution as approveExecutionControl,
  cancelRun as cancelRunControl,
  createRun,
  discardRun as discardRunControl,
  ownedRun,
  RUN_SUMMARY_SELECT,
  skipExecution as skipExecutionControl,
  type ControlDeps,
} from "@pd/engine/control";
import { getPrisma } from "@pd/db";
import { loadSandboxConfig, type TestSetup } from "@pd/sandbox";
import { ACTIVE_RUN_STATUSES, AppError, loadLimits, type EngineeringRunInput, type EngineeringRunStatus, type ExecutionApproval } from "@pd/shared";
import { createLogger } from "@pd/shared/logger";
import { enqueueEngineering } from "../queue";

/**
 * Code engine (Phase 8), web side. Approving a plan is the first gate: no change is
 * generated for a plan the owner has not approved. Runs are started, approved for
 * testing, skipped, cancelled and discarded through @pd/engine's run controls
 * (ownership, lifecycle and approval gates live there); the worker does the work.
 * Nothing here reads or changes a repository.
 */

const log = createLogger("engine");

/** The plan, if it belongs to the user (directly through its task and through the task's analysis); 404 otherwise. */
async function ownedPlan(userId: string, planId: string) {
  const plan = await getPrisma().engineeringPlan.findFirst({
    where: { id: planId, task: { userId, analysis: { repository: { userId } } } },
    select: { id: true, taskId: true, status: true, validationStatus: true, approvedAt: true },
  });
  if (!plan) throw new AppError("NOT_FOUND", "Plan not found");
  return plan;
}

/**
 * Approves a plan for the code engine. Only the task's latest plan can be approved,
 * and only once it has completed (a rejected or failed plan never completes).
 * Approving an approved plan again is a no-op that returns the original time.
 */
export async function approvePlan(userId: string, planId: string): Promise<{ id: string; approvedAt: Date }> {
  const prisma = getPrisma();
  const plan = await ownedPlan(userId, planId);
  if (plan.approvedAt) return { id: plan.id, approvedAt: plan.approvedAt };
  const latest = await prisma.engineeringPlan.findFirst({ where: { taskId: plan.taskId }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (latest?.id !== plan.id) throw new AppError("CONFLICT", "A newer plan exists for this task; review and approve that one instead.");
  if (plan.status !== "COMPLETED" || plan.validationStatus === "REJECTED") throw new AppError("CONFLICT", "Only a completed plan can be approved.");

  // Compare-and-set: a concurrent approval keeps the first timestamp.
  await prisma.engineeringPlan.updateMany({ where: { id: plan.id, status: "COMPLETED", approvedAt: null }, data: { approvedAt: new Date() } });
  const { approvedAt } = await prisma.engineeringPlan.findUniqueOrThrow({ where: { id: plan.id }, select: { approvedAt: true } });
  log.info({ planId: plan.id, validation: plan.validationStatus }, "plan approved");
  return { id: plan.id, approvedAt: approvedAt! };
}

// ---------------------------------------------------------------- runs

/** Read per call, so configuration changes apply without a restart and tests can set them. */
function controlDeps(): ControlDeps {
  const sandbox = loadSandboxConfig();
  return {
    prisma: getPrisma(),
    log,
    limits: loadLimits(),
    sandbox: { enabled: sandbox.enabled, installEnabled: sandbox.installEnabled },
    // Credentials come only from the environment; the run controls only check that a model is configured.
    env: { AI_PROVIDER: process.env.AI_PROVIDER, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL },
    enqueue: enqueueEngineering,
  };
}

const inProgress = (s: EngineeringRunStatus) => ACTIVE_RUN_STATUSES.includes(s);

/** What the UI shows of a test setup: ids and command lines, never the container environment. */
function setupView(setup: TestSetup | null) {
  if (!setup) return null;
  return {
    id: setup.id,
    runtime: setup.runtime,
    image: setup.image,
    needsInstall: setup.needsInstall,
    notes: setup.notes,
    install: setup.install ? { id: setup.install.id, command: setup.install.display } : null,
    test: { id: setup.test.id, command: setup.test.display },
  };
}

export async function startRun(userId: string, planId: string, input: EngineeringRunInput) {
  const run = await createRun(controlDeps(), userId, planId, input);
  return getRun(userId, run.id);
}

/** The plan's runs, newest first (summaries only). */
export async function listRuns(userId: string, planId: string) {
  const plan = await ownedPlan(userId, planId);
  const runs = await getPrisma().engineeringRun.findMany({ where: { planId: plan.id, userId }, orderBy: { createdAt: "desc" }, take: 20, select: RUN_SUMMARY_SELECT });
  return runs.map((r) => ({ ...r, inProgress: inProgress(r.status) }));
}

/** A run with its audit log, changes (with their diffs), sandbox executions and the test setup awaiting approval. */
export async function getRun(userId: string, runId: string) {
  const prisma = getPrisma();
  const run = await ownedRun(prisma, userId, runId);
  const [detail, events, changes, executions] = await Promise.all([
    prisma.engineeringRun.findUniqueOrThrow({ where: { id: run.id }, select: { summary: true, notes: true, patch: true } }),
    prisma.engineeringRunEvent.findMany({ where: { runId: run.id }, orderBy: { createdAt: "asc" }, take: 300, select: { type: true, actor: true, fromStatus: true, toStatus: true, message: true, createdAt: true } }),
    prisma.engineeringChange.findMany({
      where: { runId: run.id },
      orderBy: [{ iteration: "asc" }, { path: "asc" }],
      select: { iteration: true, path: true, operation: true, status: true, reason: true, additions: true, deletions: true, flags: true, diff: true },
    }),
    prisma.sandboxExecution.findMany({
      where: { runId: run.id },
      orderBy: { startedAt: "asc" },
      select: { iteration: true, kind: true, commandId: true, command: true, image: true, network: true, exitCode: true, timedOut: true, durationMs: true, output: true, outputTruncated: true, startedAt: true, finishedAt: true },
    }),
  ]);
  const sandbox = loadSandboxConfig();
  const { testSetup, ...summary } = run;
  return {
    ...summary,
    inProgress: inProgress(run.status),
    summary: detail.summary,
    notes: (detail.notes as string[] | null) ?? [],
    hasPatch: !!detail.patch,
    testSetup: setupView(testSetup as TestSetup | null),
    sandbox: { enabled: sandbox.enabled, installEnabled: sandbox.installEnabled },
    events,
    changes,
    executions,
  };
}

export async function approveRunExecution(userId: string, runId: string, approval: ExecutionApproval) {
  await approveExecutionControl(controlDeps(), userId, runId, approval);
  return getRun(userId, runId);
}

export async function skipRunExecution(userId: string, runId: string) {
  await skipExecutionControl(controlDeps(), userId, runId);
  return getRun(userId, runId);
}

export async function cancelEngineRun(userId: string, runId: string) {
  await cancelRunControl(controlDeps(), userId, runId);
  return getRun(userId, runId);
}

export async function discardEngineRun(userId: string, runId: string) {
  await discardRunControl(controlDeps(), userId, runId);
  return getRun(userId, runId);
}

/** The cumulative patch of a run ready for review, for download. */
export async function getRunPatch(userId: string, runId: string): Promise<{ filename: string; patch: string }> {
  const prisma = getPrisma();
  const run = await ownedRun(prisma, userId, runId);
  if (run.status !== "READY_FOR_REVIEW") throw new AppError("CONFLICT", "The patch is available once the run is ready for review.");
  const { patch } = await prisma.engineeringRun.findUniqueOrThrow({ where: { id: run.id }, select: { patch: true } });
  if (!patch) throw new AppError("NOT_FOUND", "This run has no patch.");
  log.info({ runId: run.id }, "patch downloaded");
  return { filename: `code-engine-${run.id}.patch`, patch };
}
