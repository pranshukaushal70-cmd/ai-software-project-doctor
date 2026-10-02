import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { ANALYZER_VERSION, uploadPath, uploadsDir } from "@pd/analyzer";
import { getPrisma, type AnalysisMode } from "@pd/db";
import { AppError, loadLimits, parseRepositoryUrl } from "@pd/shared";
import { enqueueAnalysis } from "../queue";

const ZIP_MIME = new Set(["application/zip", "application/x-zip-compressed", "application/octet-stream", "multipart/x-zip", ""]);

async function createAndEnqueue(repositoryId: string, mode: AnalysisMode) {
  const prisma = getPrisma();
  const analysis = await prisma.analysis.create({
    data: { repositoryId, mode, analyzerVersion: ANALYZER_VERSION },
    select: { id: true, status: true },
  });
  try {
    await enqueueAnalysis(analysis.id);
  } catch (err) {
    await prisma.analysis.update({
      where: { id: analysis.id },
      data: { status: "FAILED", error: "Could not queue the analysis. Please try again." },
    });
    throw err;
  }
  return { analysisId: analysis.id, status: "queued" as const };
}

export async function createAnalysisFromUrl(userId: string, url: string, mode: AnalysisMode) {
  const parsed = parseRepositoryUrl(url);
  const prisma = getPrisma();
  const source = parsed.host === "github" ? "GITHUB" : "GITLAB";
  const existing = await prisma.repository.findFirst({
    where: { userId, source, url: parsed.webUrl, branch: parsed.branch ?? null },
    select: { id: true },
  });
  const repo = existing
    ? // Touch updatedAt so a re-analysed repository moves to the top of the dashboard.
      await prisma.repository.update({ where: { id: existing.id }, data: { updatedAt: new Date() }, select: { id: true } })
    : await prisma.repository.create({
        data: { userId, source, url: parsed.webUrl, owner: parsed.owner, name: parsed.name, branch: parsed.branch },
        select: { id: true },
      });
  return createAndEnqueue(repo.id, mode);
}

/** Name of the user's demo repository; the worker analyses the bundled demo project for it. */
export const DEMO_REPOSITORY_NAME = "storefront-demo";

/** Analyse the bundled demo project. Each user has one demo repository, so re-runs and triage decisions stay together. */
export async function createDemoAnalysis(userId: string, mode: AnalysisMode) {
  const prisma = getPrisma();
  const existing = await prisma.repository.findFirst({ where: { userId, source: "DEMO" }, select: { id: true } });
  const repo = existing
    ? await prisma.repository.update({ where: { id: existing.id }, data: { updatedAt: new Date() }, select: { id: true } })
    : await prisma.repository.create({ data: { userId, source: "DEMO", name: DEMO_REPOSITORY_NAME }, select: { id: true } });
  return createAndEnqueue(repo.id, mode);
}

/** Store the uploaded archive under a random key; extraction happens in the worker. */
export async function createAnalysisFromZip(userId: string, file: File, mode: AnalysisMode) {
  const limits = loadLimits();
  if (!file.name.toLowerCase().endsWith(".zip") || !ZIP_MIME.has(file.type)) {
    throw new AppError("VALIDATION_ERROR", "Only .zip archives are accepted");
  }
  if (file.size === 0) throw new AppError("VALIDATION_ERROR", "The uploaded file is empty");
  if (file.size > limits.maxUploadBytes) {
    throw new AppError("PAYLOAD_TOO_LARGE", `Archives are limited to ${Math.round(limits.maxUploadBytes / 1024 / 1024)} MB`);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const isZip = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (!isZip) throw new AppError("UNSAFE_ARCHIVE", "File is not a valid ZIP archive");

  const key = randomUUID();
  const target = uploadPath(limits.workspaceDir, key);
  await mkdir(uploadsDir(limits.workspaceDir), { recursive: true });
  await writeFile(target, bytes, { flag: "wx", mode: 0o600 });

  const name = file.name.replace(/\.zip$/i, "").replace(/[^\w.\- ]+/g, "_").slice(0, 100) || "upload";
  try {
    const repo = await getPrisma().repository.create({
      data: { userId, source: "ZIP", name, uploadKey: key },
      select: { id: true },
    });
    return await createAndEnqueue(repo.id, mode);
  } catch (err) {
    await rm(target, { force: true });
    throw err;
  }
}

/** Fetch an analysis only if it belongs to the user; otherwise behave as if it does not exist. */
export async function getOwnedAnalysis(userId: string, analysisId: string) {
  const analysis = await getPrisma().analysis.findFirst({
    where: { id: analysisId, repository: { userId } },
    include: { repository: { select: { id: true, name: true, owner: true, url: true, source: true, branch: true } } },
  });
  if (!analysis) throw new AppError("NOT_FOUND", "Analysis not found");
  return analysis;
}

export async function listRepositories(userId: string) {
  return getPrisma().repository.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: 100,
    select: {
      id: true,
      name: true,
      owner: true,
      url: true,
      source: true,
      branch: true,
      createdAt: true,
      analyses: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, status: true, stage: true, progress: true, healthScore: true, createdAt: true },
      },
    },
  });
}
