import "server-only";
import {
  buildPlanningContext,
  createProvider,
  ProviderError,
  runPlanner,
  type ContextSources,
  type LLMProvider,
  type RepositoryFacts,
} from "@pd/agent";
import { getPrisma, type Prisma } from "@pd/db";
import { AppError, type EngineeringTaskInput } from "@pd/shared";
import { createLogger } from "@pd/shared/logger";
import { getOwnedAnalysis } from "./analysis-service";
import { graphFor, isIndexed, summaryOf } from "./intelligence-service";

/**
 * Engineering planner: developer task in, evidence-backed plan out. Context comes from
 * the Phase 6 repository index (graphFor, stored manifest, routes, findings); the LLM
 * sees only that bounded evidence bundle and its output is validated against the
 * index before it is stored. Planning only: nothing here reads file contents, runs
 * repository code or commands, or changes the repository.
 */

const log = createLogger("planner");

/** A plan still PENDING/RUNNING after this long was lost (e.g. a server restart) and is reported as failed. */
const STALE_AFTER_MS = 15 * 60 * 1000;
const FINDINGS_FOR_CONTEXT = 200;
const EXTERNAL_IMPORTS_FOR_CONTEXT = 5000;
const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

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
 * Starts a planning attempt: records a PENDING plan and returns it. The caller runs
 * `executePlan(plan.id)` after responding. One attempt per task at a time.
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
  const plan = await getPrisma().engineeringPlan.create({ data: { taskId: task.id, provider: provider.name, model: provider.model }, select: PLAN_SUMMARY_SELECT });
  return { plan: planSummary(plan), provider };
}

/** Builds the context, calls the provider, validates and stores the result. Never throws. */
export async function executePlan(planId: string, provider: LLMProvider): Promise<void> {
  const prisma = getPrisma();
  try {
    const row = await prisma.engineeringPlan.update({
      where: { id: planId },
      data: { status: "RUNNING", startedAt: new Date() },
      select: { id: true, task: { select: { userId: true, analysisId: true, request: true, scope: true, constraints: true } } },
    });
    const { task } = row;
    const analysis = await getOwnedAnalysis(task.userId, task.analysisId);
    const [graph, files, findings, external] = await Promise.all([
      graphFor(analysis),
      prisma.file.findMany({ where: { analysisId: analysis.id }, select: { path: true, kind: true } }),
      prisma.finding.findMany({
        where: { analysisId: analysis.id },
        orderBy: { createdAt: "asc" },
        take: FINDINGS_FOR_CONTEXT,
        select: { ruleId: true, title: true, severity: true, line: true, file: { select: { path: true } } },
      }),
      prisma.fileDependency.findMany({
        where: { analysisId: analysis.id, kind: "EXTERNAL", packageName: { not: null } },
        take: EXTERNAL_IMPORTS_FOR_CONTEXT,
        select: { packageName: true, fromFile: { select: { path: true } } },
      }),
    ]);
    const summary = summaryOf(analysis);
    const sources: ContextSources = {
      graph,
      manifest: summary.intelligence?.manifest ?? null,
      repositoryName: analysis.repository.owner ? `${analysis.repository.owner}/${analysis.repository.name}` : analysis.repository.name,
      routes: summary.practices?.api?.list ?? [],
      // Titles and rule ids only: finding evidence snippets never reach the model.
      findings: findings
        .map((f) => ({ ruleId: f.ruleId, title: f.title, severity: f.severity, path: f.file?.path ?? null, line: f.line }))
        .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)),
      externalImports: external.map((e) => ({ path: e.fromFile.path, packageName: e.packageName! })),
    };
    const context = buildPlanningContext({ request: task.request, scope: task.scope, constraints: (task.constraints as string[] | null) ?? [] }, sources);
    const facts: RepositoryFacts = {
      files: new Map(files.map((f) => [f.path, f.kind] as const)),
      hasSymbol: (name, path) => {
        const leaf = name.split(".").pop() ?? name;
        return graph.findSymbols(leaf, path).some((s) => s.name === leaf);
      },
    };
    await prisma.engineeringPlanEvidence.createMany({
      data: context.evidence.map((e) => ({ planId, ref: e.id, kind: e.kind, path: e.path, symbol: e.symbol, line: e.line, summary: e.summary, source: e.source })),
    });

    const result = await runPlanner(context, provider, facts);
    const meta = result.meta;
    const issues = result.report?.issues ?? [];
    log.info(
      {
        planId,
        provider: meta.provider,
        model: meta.model,
        durationMs: meta.durationMs,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        evidence: context.stats.evidence,
        validation: result.report?.status ?? null,
        errors: issues.filter((i) => i.severity === "error").length,
        warnings: issues.filter((i) => i.severity === "warning").length,
        failureReason: result.ok ? null : result.reason,
      },
      result.ok ? "plan generated" : "plan failed",
    );
    await prisma.engineeringPlan.update({
      where: { id: planId },
      data: {
        status: result.ok ? "COMPLETED" : "FAILED",
        model: meta.model,
        plan: result.ok ? (result.plan as unknown as Prisma.InputJsonValue) : undefined,
        validation: result.report ? (result.report as unknown as Prisma.InputJsonValue) : undefined,
        validationStatus: result.report?.status ?? null,
        confidence: result.ok ? result.report.confidence : null,
        contextStats: context.stats as unknown as Prisma.InputJsonValue,
        inputTokens: meta.inputTokens,
        outputTokens: meta.outputTokens,
        durationMs: meta.durationMs,
        failureReason: result.ok ? null : result.reason,
        error: result.ok ? null : result.message,
        finishedAt: new Date(),
      },
    });
  } catch (err) {
    // Internal details stay in the log (no prompt, plan or credentials are part of these errors).
    log.error({ planId, err: err instanceof Error ? { name: err.name, message: err.message } : String(err) }, "planner crashed");
    await prisma.engineeringPlan
      .update({ where: { id: planId }, data: { status: "FAILED", failureReason: "internal-error", error: "Planning failed unexpectedly.", finishedAt: new Date() } })
      .catch(() => undefined);
  }
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
