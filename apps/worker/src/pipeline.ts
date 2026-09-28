import { rm } from "node:fs/promises";
import path from "node:path";
import {
  ANALYZER_VERSION,
  cloneRepository,
  createWorkspace,
  extractZipSafely,
  scanRepository,
  uploadPath,
} from "@pd/analyzer";
import { analyzeCode } from "@pd/analyzer/metrics";
import type { AnalysisStage, Prisma, PrismaClient } from "@pd/db";
import { AppError, stageProgress, type AnalyzerLimits } from "@pd/shared";
import type { Logger } from "@pd/shared/logger";
import { buildFileRows, buildFindingRows, buildRepositoryMetricRows } from "./persist";
import { summarizeScan, type IngestInfo } from "./summary";

export interface PipelineDeps {
  prisma: PrismaClient;
  limits: AnalyzerLimits;
  log: Logger;
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
  // A retried job must not duplicate rows from a previous partial attempt.
  await prisma.finding.deleteMany({ where: { analysisId } });
  await prisma.metric.deleteMany({ where: { analysisId } });
  await prisma.file.deleteMany({ where: { analysisId } });

  const workspace = await createWorkspace(limits.workspaceDir, analysisId);
  const repo = analysis.repository;
  try {
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
    const code = await analyzeCode(scan.files, {
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

    await insertInBatches(buildFileRows(analysisId, scan, code), (data) => prisma.file.createMany({ data }));
    const fileIds = new Map(
      (await prisma.file.findMany({ where: { analysisId }, select: { id: true, path: true } })).map((f) => [f.path, f.id]),
    );
    await insertInBatches(buildFindingRows(analysisId, code.findings, fileIds), (data) => prisma.finding.createMany({ data }));
    await prisma.metric.createMany({ data: buildRepositoryMetricRows(analysisId, code) });

    await prisma.analysis.update({
      where: { id: analysisId },
      data: {
        status: "COMPLETED",
        stage: "COMPLETED",
        progress: 100,
        summary: summarizeScan(scan, ingest, code.summary) as unknown as Prisma.InputJsonObject,
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
    await workspace.dispose().catch((err) => log.warn({ err }, "workspace cleanup failed"));
    if (repo.source === "ZIP" && repo.uploadKey) {
      // Uploaded source code is deleted as soon as it has been analysed.
      await rm(uploadPath(limits.workspaceDir, repo.uploadKey), { force: true }).catch(() => undefined);
    }
  }
}
