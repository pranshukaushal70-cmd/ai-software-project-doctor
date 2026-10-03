import "server-only";
import { createProvider, ProviderError, type LLMProvider } from "@pd/agent";
import { getPrisma, type Prisma } from "@pd/db";
import { AppError, type EngineeringTaskInput } from "@pd/shared";
import { enqueueEngineering } from "../queue";
import { getOwnedAnalysis } from "./analysis-service";
import { isIndexed } from "./intelligence-service";

/**
 * Engineering planner, web side: tasks and plan requests. Planning itself (context
 * from the Phase 6 index, the LLM call, validation against the index) runs in the
 * worker as an engineering-queue job (@pd/engine executePlanJob). Planning only:
 * nothing here reads file contents, runs repository code or commands, or changes
 * the repository.
 */

/** A plan still PENDING/RUNNING after this long was lost (e.g. the worker stopped) and is reported as failed. */
const STALE_AFTER_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------- provider

let providerFactory: () => LLMProvider = () =>
  // Credentials come only from the environment; they are handed to the SDK and never stored or logged.
  createProvider({ AI_PROVIDER: process.env.AI_PROVIDER, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL });

/** Test hook: plan with a deterministic provider instead of the configured one. */
export function setProviderFactory(factory: (() => LLMProvider) | null) {
  providerFactory = factory ?? (() => createProvider({ AI_PROVIDER: process.env.AI_PROVIDER, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL }));
}

// ---------------------------------------------------------------- tasks

const TASK_SELECT = {
  id: true,
  analysisId: true,
  request: true,
  scope: true,
  constraints: true,
  createdAt: true,
  analysis: { select: { id: true, repository: { select: { id: true, name: true, owner: true } } } },
} satisfies Prisma.EngineeringTaskSelect;

const PLAN_SUMMARY_SELECT = {
  id: true,
  status: true,
  provider: true,
  model: true,
  validationStatus: true,
  confidence: true,
  failureReason: true,
  error: true,
  createdAt: true,
  finishedAt: true,
  approvedAt: true,
} satisfies Prisma.EngineeringPlanSelect;

export async function createTask(userId: string, input: EngineeringTaskInput) {
  const analysis = await getOwnedAnalysis(userId, input.analysisId);
  if (!isIndexed(analysis)) {
    throw new AppError("CONFLICT", "This analysis has no repository index. Planning needs a completed analysis made with repository intelligence; run a new analysis.");
  }
  const prisma = getPrisma();
  const scope = input.scope?.replace(/\/+$/, "");
  if (scope) {
    const inScope = await prisma.file.findFirst({ where: { analysisId: analysis.id, path: { startsWith: `${scope}/` } }, select: { id: true } });
    if (!inScope) throw new AppError("VALIDATION_ERROR", "Scope must be a directory of the analyzed repository", { details: [{ path: ["scope"], message: "No files under this directory" }] });
  }
  return prisma.engineeringTask.create({
    data: { userId, analysisId: analysis.id, request: input.task, scope: scope || null, constraints: input.constraints },
    select: TASK_SELECT,
  });
}

/** The task, if it belongs to the user (both directly and through its analysis); 404 otherwise. */
async function ownedTask(userId: string, taskId: string) {
  const task = await getPrisma().engineeringTask.findFirst({ where: { id: taskId, userId, analysis: { repository: { userId } } }, select: TASK_SELECT });
  if (!task) throw new AppError("NOT_FOUND", "Task not found");
  return task;
}

export async function getTask(userId: string, taskId: string) {
  const task = await ownedTask(userId, taskId);
  const latest = await latestPlanRow(task.id);
  return { ...task, latestPlan: latest ? planSummary(await expireIfStale(latest)) : null };
}

export async function listTasks(userId: string, analysisId: string) {
  const analysis = await getOwnedAnalysis(userId, analysisId);
  const tasks = await getPrisma().engineeringTask.findMany({
    where: { analysisId: analysis.id, userId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: { ...TASK_SELECT, plans: { orderBy: { createdAt: "desc" }, take: 1, select: PLAN_SUMMARY_SELECT } },
  });
  return tasks.map(({ plans, ...t }) => ({ ...t, latestPlan: plans[0] ? planSummary(plans[0]) : null }));
}

// ---------------------------------------------------------------- plans

type PlanRow = Prisma.EngineeringPlanGetPayload<{ select: typeof PLAN_SUMMARY_SELECT }>;

const latestPlanRow = (taskId: string) => getPrisma().engineeringPlan.findFirst({ where: { taskId }, orderBy: { createdAt: "desc" }, select: PLAN_SUMMARY_SELECT });

const planSummary = (p: PlanRow) => ({ ...p, inProgress: p.status === "PENDING" || p.status === "RUNNING" });

async function expireIfStale(p: PlanRow): Promise<PlanRow> {
  if ((p.status !== "PENDING" && p.status !== "RUNNING") || Date.now() - p.createdAt.getTime() < STALE_AFTER_MS) return p;
  const error = "Planning did not finish (the server may have restarted). Request a new plan.";
  await getPrisma().engineeringPlan.updateMany({ where: { id: p.id, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "FAILED", failureReason: "timeout", error, finishedAt: new Date() } });
  return { ...p, status: "FAILED", failureReason: "timeout", error, finishedAt: new Date() };
}

/**
 * Starts a planning attempt: records a PENDING plan and queues it for the worker.
 * One attempt per task at a time. The provider is checked here so a missing
 * configuration is reported at once; the worker creates its own from its environment.
 */
export async function requestPlan(userId: string, taskId: string) {
  const task = await ownedTask(userId, taskId);
  const latest = await latestPlanRow(task.id);
  if (latest && planSummary(await expireIfStale(latest)).inProgress) throw new AppError("CONFLICT", "A plan for this task is already being generated");
  let provider: LLMProvider;
  try {
    provider = providerFactory();
  } catch (err) {
    if (err instanceof ProviderError) throw new AppError("CONFLICT", err.message);
    throw err;
  }
  const prisma = getPrisma();
  const plan = await prisma.engineeringPlan.create({ data: { taskId: task.id, provider: provider.name, model: provider.model }, select: PLAN_SUMMARY_SELECT });
  try {
    await enqueueEngineering({ type: "plan", planId: plan.id });
  } catch (err) {
    await prisma.engineeringPlan
      .update({ where: { id: plan.id }, data: { status: "FAILED", failureReason: "queue-error", error: "Could not queue the plan. Please try again.", finishedAt: new Date() } })
      .catch(() => undefined);
    throw err;
  }
  return planSummary(plan);
}

/** The latest plan of an owned task with its evidence; `null` before any plan was requested. */
export async function getLatestPlan(userId: string, taskId: string) {
  const task = await ownedTask(userId, taskId);
  const latest = await latestPlanRow(task.id);
  if (!latest) return null;
  const summary = planSummary(await expireIfStale(latest));
  const full = await getPrisma().engineeringPlan.findUniqueOrThrow({
    where: { id: latest.id },
    select: {
      plan: true,
      validation: true,
      contextStats: true,
      inputTokens: true,
      outputTokens: true,
      durationMs: true,
      startedAt: true,
      evidence: { orderBy: { id: "asc" }, select: { ref: true, kind: true, path: true, symbol: true, line: true, summary: true, source: true } },
    },
  });
  const evidence = full.evidence.sort((a, b) => Number(a.ref.slice(1)) - Number(b.ref.slice(1)));
  return { ...summary, ...full, evidence };
}

/** The user's completed analyses that have a repository index, newest first: what the planner can plan against. */
export async function listPlannableAnalyses(userId: string) {
  const analyses = await getPrisma().analysis.findMany({
    where: { repository: { userId }, status: "COMPLETED" },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, status: true, createdAt: true, summary: true, repository: { select: { name: true, owner: true } } },
  });
  return analyses
    .filter((a) => !!(a.summary as { intelligence?: unknown } | null)?.intelligence)
    .map((a) => ({ id: a.id, createdAt: a.createdAt.toISOString(), repository: a.repository.owner ? `${a.repository.owner}/${a.repository.name}` : a.repository.name }));
}
