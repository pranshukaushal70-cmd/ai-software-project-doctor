import type { PrismaClient } from "@pd/db";
import { AppError, type ReportTypeName } from "@pd/shared";
import type { FindingRow, PlanInput, ReportInput, RunInput } from "./input";

/**
 * Loads what a report is built from, with the ownership checks of the rest of the
 * application: the subject (analysis, plan or run) must belong to the user directly
 * and through the repository; anything else is "not found" (404), never "forbidden",
 * so ids cannot be probed. Queries are selective and bounded: counts are grouped in
 * the database, only the most severe findings are loaded, and the run's patch (code)
 * is never read, only whether it exists.
 */

export interface ReportSubject {
  type: ReportTypeName;
  id: string;
}

export interface CollectedReport {
  input: ReportInput;
  refs: { repositoryId: string; analysisId: string; planId: string | null; runId: string | null };
}

export type ReportPrisma = Pick<
  PrismaClient,
  "analysis" | "finding" | "findingTriage" | "dependency" | "engineeringPlan" | "engineeringRun" | "engineeringRunEvent" | "engineeringChange" | "sandboxExecution" | "report"
>;

const TOP_FINDINGS = 25;
const SECURITY_FINDINGS = 15;
const RUN_EVENTS = 200;
const RUN_CHANGES = 200;
const RUN_EXECUTIONS = 50;

const PLAN_SELECT = {
  id: true,
  status: true,
  provider: true,
  model: true,
  validationStatus: true,
  confidence: true,
  plan: true,
  validation: true,
  failureReason: true,
  error: true,
  createdAt: true,
  finishedAt: true,
  approvedAt: true,
  task: { select: { id: true, analysisId: true, request: true, scope: true, constraints: true, createdAt: true } },
} as const;

const notFound = (what: string) => new AppError("NOT_FOUND", `${what} not found`);

export async function collectReportInput(prisma: ReportPrisma, userId: string, subject: ReportSubject): Promise<CollectedReport> {
  let planRow: Awaited<ReturnType<typeof loadPlan>> = null;
  let runRow: Awaited<ReturnType<typeof loadRun>> = null;
  let analysisId = subject.id;

  if (subject.type === "RUN") {
    runRow = await loadRun(prisma, userId, subject.id);
    if (!runRow) throw notFound("Run");
    planRow = runRow.plan;
    analysisId = runRow.plan.task.analysisId;
  } else if (subject.type === "PLAN") {
    planRow = await loadPlan(prisma, userId, subject.id);
    if (!planRow) throw notFound("Plan");
    analysisId = planRow.task.analysisId;
  }

  const analysis = await prisma.analysis.findFirst({
    where: { id: analysisId, repository: { userId } },
    select: {
      id: true,
      status: true,
      stage: true,
      analyzerVersion: true,
      commitSha: true,
      error: true,
      summary: true,
      healthScore: true,
      scoreBreakdown: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      repository: { select: { id: true, name: true, owner: true, source: true, url: true, branch: true } },
    },
  });
  if (!analysis) throw notFound(subject.type === "ANALYSIS" ? "Analysis" : "Analysis of this plan");

  const findingWhere = { analysisId: analysis.id };
  const findingSelect = { severity: true, category: true, ruleId: true, title: true, line: true, fingerprint: true, file: { select: { path: true } } } as const;
  const findingOrder = [{ severity: "asc" as const }, { file: { path: "asc" as const } }, { line: "asc" as const }, { id: "asc" as const }];
  const [total, bySeverity, byCategory, triages, top, security, dependencies, vulnerable, latestPlan, run] = await Promise.all([
    prisma.finding.count({ where: findingWhere }),
    prisma.finding.groupBy({ by: ["severity"], where: findingWhere, _count: { _all: true } }),
    prisma.finding.groupBy({ by: ["category"], where: findingWhere, _count: { _all: true } }),
    prisma.findingTriage.findMany({ where: { repositoryId: analysis.repository.id }, select: { fingerprint: true } }),
    prisma.finding.findMany({ where: findingWhere, orderBy: findingOrder, take: TOP_FINDINGS, select: findingSelect }),
    prisma.finding.findMany({ where: { ...findingWhere, category: { in: ["SECRET", "SECURITY", "DEPENDENCY"] } }, orderBy: findingOrder, take: SECURITY_FINDINGS, select: findingSelect }),
    prisma.dependency.count({ where: { analysisId: analysis.id } }),
    prisma.dependency.count({ where: { analysisId: analysis.id, vulnIds: { isEmpty: false } } }),
    planRow ? prisma.engineeringPlan.findFirst({ where: { taskId: planRow.task.id }, orderBy: { createdAt: "desc" }, select: { id: true } }) : null,
    runRow ? loadRunDetails(prisma, runRow) : null,
  ]);
  const triaged = new Set(triages.map((t) => t.fingerprint));
  const triagedCount = triaged.size ? await prisma.finding.count({ where: { ...findingWhere, fingerprint: { in: [...triaged] } } }) : 0;
  const row = (f: (typeof top)[number]): FindingRow => ({ severity: f.severity, category: f.category, ruleId: f.ruleId, title: f.title, path: f.file?.path ?? null, line: f.line, triaged: triaged.has(f.fingerprint) });

  const plan: PlanInput | null = planRow
    ? {
        id: planRow.id,
        status: planRow.status,
        provider: planRow.provider,
        model: planRow.model,
        validationStatus: planRow.validationStatus,
        confidence: planRow.confidence,
        plan: planRow.plan,
        validation: planRow.validation,
        failureReason: planRow.failureReason,
        error: planRow.error,
        createdAt: planRow.createdAt,
        finishedAt: planRow.finishedAt,
        approvedAt: planRow.approvedAt,
        isLatest: latestPlan?.id === planRow.id,
        task: { id: planRow.task.id, request: planRow.task.request, scope: planRow.task.scope, constraints: planRow.task.constraints, createdAt: planRow.task.createdAt },
      }
    : null;

  return {
    input: {
      type: subject.type,
      repository: analysis.repository,
      analysis: {
        id: analysis.id,
        status: analysis.status,
        stage: analysis.stage,
        analyzerVersion: analysis.analyzerVersion,
        commitSha: analysis.commitSha,
        error: analysis.error,
        summary: analysis.summary,
        healthScore: analysis.healthScore,
        scoreBreakdown: analysis.scoreBreakdown,
        createdAt: analysis.createdAt,
        startedAt: analysis.startedAt,
        finishedAt: analysis.finishedAt,
      },
      findings: {
        total,
        triaged: triagedCount,
        bySeverity: Object.fromEntries(bySeverity.map((g) => [g.severity, g._count._all])),
        byCategory: Object.fromEntries(byCategory.map((g) => [g.category, g._count._all])),
        top: top.map(row),
        security: security.map(row),
      },
      dependencies: { total: dependencies, vulnerable },
      plan,
      run,
    },
    refs: { repositoryId: analysis.repository.id, analysisId: analysis.id, planId: planRow?.id ?? null, runId: runRow?.id ?? null },
  };
}

function loadPlan(prisma: ReportPrisma, userId: string, planId: string) {
  return prisma.engineeringPlan.findFirst({ where: { id: planId, task: { userId, analysis: { repository: { userId } } } }, select: PLAN_SELECT });
}

function loadRun(prisma: ReportPrisma, userId: string, runId: string) {
  return prisma.engineeringRun.findFirst({
    where: { id: runId, userId, plan: { task: { userId, analysis: { repository: { userId } } } } },
    select: {
      id: true,
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
      summary: true,
      notes: true,
      testSetup: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      plan: { select: PLAN_SELECT },
    },
  });
}

async function loadRunDetails(prisma: ReportPrisma, run: NonNullable<Awaited<ReturnType<typeof loadRun>>>): Promise<RunInput> {
  const [hasPatch, events, changes, executions] = await Promise.all([
    // Whether a patch is stored, without reading it: reports never copy code.
    prisma.engineeringRun.count({ where: { id: run.id, patch: { not: null } } }),
    // The most recent events (one extra to detect truncation), restored to chronological order below.
    prisma.engineeringRunEvent.findMany({
      where: { runId: run.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: RUN_EVENTS + 1,
      select: { type: true, actor: true, fromStatus: true, toStatus: true, message: true, createdAt: true },
    }),
    prisma.engineeringChange.findMany({
      where: { runId: run.id },
      orderBy: [{ iteration: "asc" }, { path: "asc" }, { id: "asc" }],
      take: RUN_CHANGES + 1,
      select: { iteration: true, path: true, operation: true, status: true, reason: true, additions: true, deletions: true, flags: true },
    }),
    prisma.sandboxExecution.findMany({
      where: { runId: run.id },
      orderBy: [{ startedAt: "asc" }, { id: "asc" }],
      take: RUN_EXECUTIONS,
      select: { iteration: true, kind: true, commandId: true, command: true, image: true, network: true, exitCode: true, timedOut: true, durationMs: true, output: true, outputTruncated: true },
    }),
  ]);
  const { plan: _plan, ...fields } = run;
  return {
    ...fields,
    hasPatch: hasPatch > 0,
    events: events.slice(0, RUN_EVENTS).reverse(),
    eventsTruncated: events.length > RUN_EVENTS,
    changes: changes.slice(0, RUN_CHANGES),
    changesTruncated: changes.length > RUN_CHANGES,
    executions,
  };
}
