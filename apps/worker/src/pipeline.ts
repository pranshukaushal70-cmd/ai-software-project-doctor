import { rm } from "node:fs/promises";
import path from "node:path";
import { ANALYZER_VERSION, cloneRepository, createWorkspace, uploadPath, type Workspace } from "@pd/analyzer";
import { runAnalyzers } from "@pd/analyzer/run";
import { scoringWeights } from "@pd/analyzer/scoring";
import type { AnalysisStage, Prisma, PrismaClient } from "@pd/db";
import { AppError, stageProgress, type AnalyzerLimits } from "@pd/shared";
import type { Logger } from "@pd/shared/logger";
import { copyDemoProject, DEFAULT_DEMO_DIR, extractUpload } from "@pd/engine";
import {
  buildArchitectureEdgeRows,
  buildArchitectureMetricRows,
  buildArchitectureNodeRows,
  buildDependencyMetricRows,
  buildDependencyRows,
  buildFileDependencyRows,
  buildFileRows,
  buildFindingRows,
  buildIntelligenceMetricRows,
  buildPracticeMetricRows,
  buildReferenceRows,
  buildRepositoryMetricRows,
  buildScoreMetricRows,
  buildSecurityMetricRows,
  buildSymbolRows,
} from "./persist";
import { summarizeScan, type IngestInfo } from "./summary";

export interface PipelineDeps {
  prisma: PrismaClient;
  limits: AnalyzerLimits;
  log: Logger;
  /** HTTP client for the OSV.dev lookup; defaults to the global fetch. Tests inject a fake so they never touch the network. */
  fetch?: typeof fetch;
  /** The bundled demo project analysed for DEMO repositories; defaults to `demo/storefront` in this repository. */
  demoDir?: string;
}

export { DEFAULT_DEMO_DIR };

const INSERT_BATCH = 1000;
/** Minimum interval between progress writes while parsing. */
const PROGRESS_INTERVAL_MS = 1000;

async function insertInBatches<T>(rows: T[], insert: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += INSERT_BATCH) await insert(rows.slice(i, i + INSERT_BATCH));
}

export async function runAnalysis(analysisId: string, deps: PipelineDeps): Promise<void> {
  const { prisma, limits } = deps;
  const log = deps.log.child({ analysisId });
  const started = Date.now();

  const analysis = await prisma.analysis.findUnique({ where: { id: analysisId }, include: { repository: true } });
  if (!analysis) {
    log.warn("analysis not found; dropping job");
    return;
  }
  if (analysis.status === "COMPLETED") {
    log.info("analysis already completed; skipping");
    return;
  }

  const setStage = (stage: AnalysisStage) =>
    prisma.analysis.update({ where: { id: analysisId }, data: { stage, progress: stageProgress(stage) } });

  await prisma.analysis.update({
    where: { id: analysisId },
    data: { status: "RUNNING", startedAt: new Date(), error: null, analyzerVersion: ANALYZER_VERSION },
  });
  const repo = analysis.repository;
  let workspace: Workspace | undefined;
  let completed = false;
  // Everything after the RUNNING transition is inside the try, so any failure
  // marks the analysis FAILED instead of leaving the UI polling a RUNNING row forever.
  try {
    // A retried job must not duplicate rows from a previous partial attempt.
    await prisma.symbolReference.deleteMany({ where: { analysisId } });
    await prisma.codeSymbol.deleteMany({ where: { analysisId } });
    await prisma.fileDependency.deleteMany({ where: { analysisId } });
    await prisma.architectureEdge.deleteMany({ where: { analysisId } });
    await prisma.architectureNode.deleteMany({ where: { analysisId } });
    await prisma.dependency.deleteMany({ where: { analysisId } });
    await prisma.finding.deleteMany({ where: { analysisId } });
    await prisma.metric.deleteMany({ where: { analysisId } });
    await prisma.file.deleteMany({ where: { analysisId } });

    workspace = await createWorkspace(limits.workspaceDir, analysisId);
    await setStage("CLONING");
    let root: string;
    const ingest: IngestInfo = { source: repo.source };

    if (repo.source === "GITHUB" || repo.source === "GITLAB") {
      if (!repo.url) throw new AppError("VALIDATION_ERROR", "Repository has no URL");
      const cloned = await cloneRepository({
        url: repo.url,
        branch: repo.branch ?? undefined,
        destDir: workspace.dir,
        depth: limits.cloneDepth,
        timeoutMs: limits.cloneTimeoutMs,
      });
      root = cloned.dir;
      ingest.commitSha = cloned.commitSha;
      await prisma.analysis.update({ where: { id: analysisId }, data: { commitSha: cloned.commitSha } });
    } else if (repo.source === "ZIP") {
      if (!repo.uploadKey) throw new AppError("VALIDATION_ERROR", "Uploaded archive is missing");
      const extracted = await extractUpload(limits, repo.uploadKey, path.join(workspace.dir, "src"));
      root = extracted.root;
      Object.assign(ingest, {
        extractedFiles: extracted.extractedFiles,
        skippedEntries: extracted.skippedEntries,
        oversizedEntries: extracted.oversizedEntries,
      });
    } else if (repo.source === "DEMO") {
      // A copy, so nothing the analysis does can touch the bundled project.
      root = path.join(workspace.dir, "src");
      await copyDemoProject(deps.demoDir ?? DEFAULT_DEMO_DIR, root);
      ingest.demo = path.basename(deps.demoDir ?? DEFAULT_DEMO_DIR);
    } else {
      throw new AppError("VALIDATION_ERROR", "Unsupported repository source");
    }

    const parseStart = stageProgress("PARSING");
    const parseSpan = stageProgress("SECURITY") - parseStart - 1;
    let lastProgressAt = 0;
    const { scan, code, security: sec, dependencies: dep, architecture: arch, practices, findings: allFindings, health, index } = await runAnalyzers(root, {
      name: repo.name,
      maxFileBytes: limits.maxFileBytes,
      osv: limits.osvEnabled ? { fetch: deps.fetch ?? globalThis.fetch, budgetMs: limits.osvBudgetMs } : undefined,
      // Findings the user already marked Expected or Ignored for this repository do not lower the score.
      excludedFingerprints: async () =>
        new Set((await prisma.findingTriage.findMany({ where: { repositoryId: repo.id }, select: { fingerprint: true } })).map((t) => t.fingerprint)),
      onStage: setStage,
      onParseProgress: async (done, total) => {
        if (Date.now() - lastProgressAt < PROGRESS_INTERVAL_MS) return;
        lastProgressAt = Date.now();
        await prisma.analysis.update({
          where: { id: analysisId },
          data: { progress: parseStart + Math.floor((done / Math.max(total, 1)) * parseSpan) },
        });
      },
      log,
    });
    await insertInBatches(buildFileRows(analysisId, scan, code), (data) => prisma.file.createMany({ data }));
    const fileIds = new Map(
      (await prisma.file.findMany({ where: { analysisId }, select: { id: true, path: true } })).map((f) => [f.path, f.id]),
    );
    const findingRows = buildFindingRows(analysisId, allFindings, fileIds);
    await insertInBatches(findingRows, (data) => prisma.finding.createMany({ data }));
    await prisma.metric.createMany({
      data: [
        ...buildRepositoryMetricRows(analysisId, code),
        ...buildSecurityMetricRows(analysisId, sec),
        ...buildDependencyMetricRows(analysisId, dep),
        ...buildArchitectureMetricRows(analysisId, arch),
        ...buildPracticeMetricRows(analysisId, practices),
        ...buildScoreMetricRows(analysisId, health),
        ...buildIntelligenceMetricRows(analysisId, index),
      ],
    });
    await insertInBatches(buildDependencyRows(analysisId, dep.dependencies), (data) => prisma.dependency.createMany({ data }));
    await insertInBatches(buildArchitectureNodeRows(analysisId, arch.nodes), (data) => prisma.architectureNode.createMany({ data }));
    const nodeIds = new Map(
      (await prisma.architectureNode.findMany({ where: { analysisId }, select: { id: true, key: true } })).map((n) => [n.key, n.id]),
    );
    await insertInBatches(buildArchitectureEdgeRows(analysisId, arch.edges, nodeIds), (data) => prisma.architectureEdge.createMany({ data }));
    await insertInBatches(buildFileDependencyRows(analysisId, index.dependencies, fileIds), (data) => prisma.fileDependency.createMany({ data }));
    await insertInBatches(buildSymbolRows(analysisId, index.symbols, fileIds), (data) => prisma.codeSymbol.createMany({ data }));
    const symbolIds = new Map(
      (await prisma.codeSymbol.findMany({ where: { analysisId }, select: { id: true, key: true } })).map((s) => [s.key, s.id]),
    );
    await insertInBatches(buildReferenceRows(analysisId, index.references, fileIds, symbolIds), (data) => prisma.symbolReference.createMany({ data }));

    await prisma.analysis.update({
      where: { id: analysisId },
      data: {
        status: "COMPLETED",
        stage: "COMPLETED",
        progress: 100,
        summary: summarizeScan(scan, ingest, code.summary, sec.summary, dep.summary, arch.summary, practices.summary, index.summary) as unknown as Prisma.InputJsonObject,
        healthScore: health.score,
        scoreBreakdown: health as unknown as Prisma.InputJsonObject,
        weightsUsed: scoringWeights() as unknown as Prisma.InputJsonObject,
        finishedAt: new Date(),
      },
    });
    completed = true;
    log.info({ ms: Date.now() - started }, "analysis completed");
  } catch (err) {
    const message = err instanceof AppError ? err.message : "Analysis failed due to an internal error";
    log.error({ err, ms: Date.now() - started }, "analysis failed");
    await prisma.analysis.update({
      where: { id: analysisId },
      data: { status: "FAILED", error: message, finishedAt: new Date() },
    });
  } finally {
    await workspace?.dispose().catch((err) => log.warn({ err }, "workspace cleanup failed"));
    if (repo.source === "ZIP" && repo.uploadKey && !completed) {
      // The archive of a completed analysis is kept until the analysis is deleted, so the code engine
      // (Phase 8) can rebuild the analysed source; uploads.ts deletes it then. Nothing can use the archive
      // of a failed analysis, so it is deleted at once.
      await rm(uploadPath(limits.workspaceDir, repo.uploadKey), { force: true }).catch(() => undefined);
    }
  }
}
