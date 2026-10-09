import { buildPlanningContext, ProviderError, runPlanner, type ContextSources, type LLMProvider, type RepositoryFacts } from "@pd/agent";
import type { Prisma, PrismaClient } from "@pd/db";
import type { Logger } from "@pd/shared/logger";
import { loadRepositoryGraph, type StoredSummary } from "./graph";

/**
 * The engineering planner's job (Phase 7, moved to the worker in Phase 8): builds
 * the evidence context from the stored index, calls the provider, validates the plan
 * against the index and stores the result. Planning only: nothing reads file
 * contents, runs repository code or changes the repository.
 */

const FINDINGS_FOR_CONTEXT = 200;
const EXTERNAL_IMPORTS_FOR_CONTEXT = 5000;
const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 };

export interface PlanJobDeps {
  prisma: PrismaClient;
  log: Logger;
  /** The configured planning provider (credentials from the worker's environment only). */
  provider: () => LLMProvider;
}

/** Builds the context, calls the provider, validates and stores the result. Never throws. */
export async function executePlanJob(planId: string, deps: PlanJobDeps): Promise<void> {
  const { prisma, log } = deps;
  try {
    const claimed = await prisma.engineeringPlan.updateMany({ where: { id: planId, status: "PENDING" }, data: { status: "RUNNING", startedAt: new Date() } });
    // Already taken by another attempt, expired or gone: nothing to do.
    if (claimed.count === 0) return;
    const row = await prisma.engineeringPlan.findUniqueOrThrow({
      where: { id: planId },
      select: { id: true, task: { select: { userId: true, analysisId: true, request: true, scope: true, constraints: true } } },
    });
    const { task } = row;
    // Ownership is re-checked here: the analysis must still belong to the task's owner.
    const analysis = await prisma.analysis.findFirst({
      where: { id: task.analysisId, repository: { userId: task.userId } },
      include: { repository: { select: { name: true, owner: true } } },
    });
    if (!analysis) throw new Error("analysis not found");
    let provider: LLMProvider;
    try {
      provider = deps.provider();
    } catch (err) {
      // The worker's environment decides; a missing key there is a configuration problem, not a crash.
      const error = err instanceof ProviderError ? err.message : "No AI provider is configured for the worker.";
      log.warn({ planId }, "plan failed: provider not configured");
      await prisma.engineeringPlan.update({ where: { id: planId }, data: { status: "FAILED", failureReason: "not-configured", error, finishedAt: new Date() } });
      return;
    }
    const [graph, files, findings, external] = await Promise.all([
      loadRepositoryGraph(prisma, analysis),
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
    const summary = (analysis.summary ?? {}) as StoredSummary;
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
        // The API's status, error type and request id when the provider call failed (no prompt, no key).
        providerError: result.ok ? null : (result.detail ?? null),
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
