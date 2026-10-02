import { rm } from "node:fs/promises";
import path from "node:path";
import {
  ANALYZER_VERSION,
  cloneRepository,
  createWorkspace,
  extractZipSafely,
  scanRepository,
  uploadPath,
  type Workspace,
} from "@pd/analyzer";
import { analyzeArchitecture } from "@pd/analyzer/architecture";
import { analyzeDependencies } from "@pd/analyzer/dependencies";
import { analyzeCode } from "@pd/analyzer/metrics";
import { createSecurityScanner } from "@pd/analyzer/security";
import type { AnalysisStage, Prisma, PrismaClient } from "@pd/db";
import { AppError, stageProgress, type AnalyzerLimits } from "@pd/shared";
import type { Logger } from "@pd/shared/logger";
import {
  buildArchitectureEdgeRows,
  buildArchitectureMetricRows,
  buildArchitectureNodeRows,
  buildDependencyMetricRows,
  buildDependencyRows,
  buildFileRows,
  buildFindingRows,
  buildRepositoryMetricRows,
  buildSecurityMetricRows,
} from "./persist";
import { summarizeScan, type IngestInfo } from "./summary";

export interface PipelineDeps {
  prisma: PrismaClient;
  limits: AnalyzerLimits;
  log: Logger;
  /** HTTP client for the OSV.dev lookup; defaults to the global fetch. Tests inject a fake so they never touch the network. */
  fetch?: typeof fetch;
}

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
  // Everything after the RUNNING transition is inside the try, so any failure
  // marks the analysis FAILED instead of leaving the UI polling a RUNNING row forever.
  try {
    // A retried job must not duplicate rows from a previous partial attempt.
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
      const extracted = await extractZipSafely(uploadPath(limits.workspaceDir, repo.uploadKey), path.join(workspace.dir, "src"), {
        maxEntries: limits.maxZipEntries,
        maxExtractedBytes: limits.maxExtractedBytes,
        maxCompressionRatio: limits.maxCompressionRatio,
        maxFileBytes: limits.maxFileBytes,
      });
      root = extracted.root;
      Object.assign(ingest, {
        extractedFiles: extracted.extractedFiles,
        skippedEntries: extracted.skippedEntries,
        oversizedEntries: extracted.oversizedEntries,
      });
    } else {
      throw new AppError("ANALYSIS_FAILED", "The demo project is not available in this version yet");
    }

    await setStage("SCANNING");
    const scan = await scanRepository(root, { maxFileBytes: limits.maxFileBytes });
    log.info({ files: scan.totals.files, ms: Date.now() - started }, "scan complete");

    await setStage("PARSING");
    const parseStart = stageProgress("PARSING");
    const parseSpan = stageProgress("SECURITY") - parseStart - 1;
    let lastProgressAt = 0;
    // Insecure-pattern rules run on the same syntax trees as the metrics (one parse per file).
    const security = createSecurityScanner();
    const code = await analyzeCode(scan.files, {
      onTree: security.inspectTree,
      onProgress: async (done, total) => {
        if (Date.now() - lastProgressAt < PROGRESS_INTERVAL_MS) return;
        lastProgressAt = Date.now();
        await prisma.analysis.update({
          where: { id: analysisId },
          data: { progress: parseStart + Math.floor((done / Math.max(total, 1)) * parseSpan) },
        });
      },
    });
    log.info(
      { files: code.summary.totals.filesAnalyzed, findings: code.summary.findings.total, ms: code.summary.durationMs },
      "code metrics complete",
    );

    await setStage("SECURITY");
    const sec = await security.finish(scan);
    log.info(
      { findings: sec.summary.totals.findings, secrets: sec.summary.totals.secrets, ms: sec.summary.durationMs },
      "security analysis complete",
    );

    const fileImports = code.files.map((f) => ({ path: f.path, language: f.language, imports: f.metrics.imports, codeLines: f.metrics.codeLines }));

    await setStage("DEPENDENCIES");
    // The OSV.dev lookup never throws: an outage is recorded in the summary and the analysis continues.
    const dep = await analyzeDependencies(scan.files, {
      osv: limits.osvEnabled ? { fetch: deps.fetch ?? globalThis.fetch, budgetMs: limits.osvBudgetMs } : undefined,
      imports: fileImports,
    });
    log.info(
      {
        dependencies: dep.summary.totals.dependencies,
        vulnerable: dep.summary.totals.vulnerable,
        osv: dep.summary.vulnerabilityScan.status,
        ms: dep.summary.durationMs,
      },
      "dependency analysis complete",
    );

    await setStage("ARCHITECTURE");
    const arch = await analyzeArchitecture(scan.files, fileImports, new Map(scan.files.map((f) => [f.path, f.kind])));
    log.info(
      { files: arch.summary.totals.files, edges: arch.summary.totals.edges, cycles: arch.summary.totals.cycles, ms: arch.summary.durationMs },
      "architecture analysis complete",
    );

    await insertInBatches(buildFileRows(analysisId, scan, code), (data) => prisma.file.createMany({ data }));
    const fileIds = new Map(
      (await prisma.file.findMany({ where: { analysisId }, select: { id: true, path: true } })).map((f) => [f.path, f.id]),
    );
    const findingRows = buildFindingRows(analysisId, [...code.findings, ...sec.findings, ...dep.findings, ...arch.findings], fileIds);
    await insertInBatches(findingRows, (data) => prisma.finding.createMany({ data }));
    await prisma.metric.createMany({
      data: [
        ...buildRepositoryMetricRows(analysisId, code),
        ...buildSecurityMetricRows(analysisId, sec),
        ...buildDependencyMetricRows(analysisId, dep),
        ...buildArchitectureMetricRows(analysisId, arch),
      ],
    });
    await insertInBatches(buildDependencyRows(analysisId, dep.dependencies), (data) => prisma.dependency.createMany({ data }));
    await insertInBatches(buildArchitectureNodeRows(analysisId, arch.nodes), (data) => prisma.architectureNode.createMany({ data }));
    const nodeIds = new Map(
      (await prisma.architectureNode.findMany({ where: { analysisId }, select: { id: true, key: true } })).map((n) => [n.key, n.id]),
    );
    await insertInBatches(buildArchitectureEdgeRows(analysisId, arch.edges, nodeIds), (data) => prisma.architectureEdge.createMany({ data }));

    await prisma.analysis.update({
      where: { id: analysisId },
      data: {
        status: "COMPLETED",
        stage: "COMPLETED",
        progress: 100,
        summary: summarizeScan(scan, ingest, code.summary, sec.summary, dep.summary, arch.summary) as unknown as Prisma.InputJsonObject,
        finishedAt: new Date(),
      },
    });
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
    if (repo.source === "ZIP" && repo.uploadKey) {
      // Uploaded source code is deleted as soon as it has been analysed.
      await rm(uploadPath(limits.workspaceDir, repo.uploadKey), { force: true }).catch(() => undefined);
    }
  }
}
