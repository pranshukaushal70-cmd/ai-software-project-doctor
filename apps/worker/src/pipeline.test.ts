import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uploadPath, uploadsDir } from "@pd/analyzer";
import type { PrismaClient } from "@pd/db";
import { loadLimits, type AnalyzerLimits } from "@pd/shared";
import type { Logger } from "@pd/shared/logger";
import { buildZip } from "../../../packages/analyzer/test/zip-builder";
import { runAnalysis } from "./pipeline";

const FIXTURE = path.resolve(import.meta.dirname, "../../../packages/analyzer/test/fixtures/polyglot");
const FIXTURE_FILES = ["package.json", "README.md", "src/orders.ts", "src/format.ts", "src/utils/csv.js", "app/pipeline.py", "tests/orders.test.ts"];

type Row = Record<string, unknown>;

/** In-memory stand-in for the handful of Prisma calls the pipeline makes. */
function fakePrisma(analysis: Row, opts: { failOn?: string } = {}) {
  const tables = { file: [] as Row[], finding: [] as Row[], metric: [] as Row[] };
  const updates: Row[] = [];
  let seq = 0;
  const guard = (op: string) => {
    if (opts.failOn === op) throw new Error(`simulated database failure in ${op}`);
  };
  const table = (name: keyof typeof tables) => ({
    deleteMany: async ({ where }: { where: { analysisId: string } }) => {
      guard(`${name}.deleteMany`);
      const before = tables[name].length;
      tables[name] = tables[name].filter((r) => r.analysisId !== where.analysisId);
      return { count: before - tables[name].length };
    },
    createMany: async ({ data }: { data: Row[] }) => {
      guard(`${name}.createMany`);
      for (const r of data) tables[name].push({ id: `${name}${seq++}`, ...r });
      return { count: data.length };
    },
    findMany: async ({ where }: { where: { analysisId: string } }) => tables[name].filter((r) => r.analysisId === where.analysisId),
  });
  const prisma = {
    analysis: {
      findUnique: async () => analysis,
      update: async ({ data }: { data: Row }) => {
        guard("analysis.update");
        updates.push(data);
        Object.assign(analysis, data);
        return analysis;
      },
    },
    file: table("file"),
    finding: table("finding"),
    metric: table("metric"),
  };
  return { prisma: prisma as unknown as PrismaClient, tables, updates };
}

const silentLog = {
  child: () => silentLog,
  debug() {},
  info() {},
  warn() {},
  error() {},
} as unknown as Logger;

let workspaceDir: string;
let limits: AnalyzerLimits;

beforeEach(async () => {
  workspaceDir = await mkdtemp(path.join(os.tmpdir(), "pd-pipeline-test-"));
  limits = loadLimits({ WORKSPACE_DIR: workspaceDir });
});

afterEach(async () => {
  await rm(workspaceDir, { recursive: true, force: true });
});

/** A committed .env with a credential, so the upload exercises the security stage. */
const ENV_FILE = { path: ".env", content: "PORT=3000\nDB_PASSWORD=Xk92_mq7PzLw\n" };
const ALL_FILES = [...FIXTURE_FILES, ENV_FILE.path];

async function stageUpload(): Promise<string> {
  const entries = await Promise.all(
    FIXTURE_FILES.map(async (rel) => ({ name: `polyglot-main/${rel}`, data: await readFile(path.join(FIXTURE, rel)), deflate: true })),
  );
  entries.push({ name: `polyglot-main/${ENV_FILE.path}`, data: Buffer.from(ENV_FILE.content), deflate: false });
  const key = randomUUID();
  await mkdir(uploadsDir(workspaceDir), { recursive: true });
  await writeFile(uploadPath(workspaceDir, key), buildZip(entries));
  return key;
}

const zipAnalysis = (uploadKey: string | null): Row => ({
  id: "an1",
  status: "QUEUED",
  repository: { id: "repo1", source: "ZIP", url: null, branch: null, uploadKey },
});

describe("runAnalysis", () => {
  it("analyses an uploaded ZIP and persists files, findings and metrics", async () => {
    const key = await stageUpload();
    const analysis = zipAnalysis(key);
    const { prisma, tables, updates } = fakePrisma(analysis);
    // Rows left by an earlier, interrupted attempt must be replaced, not duplicated.
    tables.finding.push({ id: "stale", analysisId: "an1" });

    await runAnalysis("an1", { prisma, limits, log: silentLog });

    expect(analysis).toMatchObject({ status: "COMPLETED", stage: "COMPLETED", progress: 100, analyzerVersion: expect.any(String) });
    expect(updates.map((u) => u.stage).filter(Boolean)).toEqual(["CLONING", "SCANNING", "PARSING", "SECURITY", "COMPLETED"]);

    expect(tables.file.map((f) => f.path).sort()).toEqual([...ALL_FILES].sort());
    expect(tables.file.find((f) => f.path === "src/orders.ts")).toMatchObject({ kind: "SOURCE", loc: 62, maxComplexity: 15 });
    expect(tables.finding.some((f) => f.id === "stale")).toBe(false);
    expect(tables.finding.length).toBeGreaterThan(0);
    const fileIds = new Set(tables.file.map((f) => f.id));
    expect(tables.finding.every((f) => fileIds.has(f.fileId as string))).toBe(true);
    expect(tables.metric.find((m) => m.key === "code.files")?.value).toBe(5);

    // Security findings are persisted next to code-quality findings, linked to their file.
    const envFileId = tables.file.find((f) => f.path === ".env")?.id;
    const secrets = tables.finding.filter((f) => f.category === "SECRET");
    expect(secrets.map((f) => f.ruleId).sort()).toEqual(["secret/committed-env-file", "secret/hardcoded-credential"]);
    expect(secrets.every((f) => f.fileId === envFileId && f.analyzer === "security")).toBe(true);
    expect(JSON.stringify(tables.finding)).not.toContain("Xk92_mq7PzLw");
    expect(tables.metric.find((m) => m.key === "security.secrets")?.value).toBe(2);

    const summary = analysis.summary as { modulesRun: string[]; ingest: Row; codeMetrics: { totals: Row }; security: { totals: Row; envFiles: string[] } };
    expect(summary.modulesRun).toEqual(["repository-scan", "code-metrics", "security"]);
    expect(summary.ingest).toMatchObject({ source: "ZIP", extractedFiles: ALL_FILES.length });
    expect(summary.security.totals).toMatchObject({ secrets: 2 });
    expect(summary.security.envFiles).toEqual([".env"]);
    expect(JSON.stringify(summary)).not.toContain(workspaceDir);
    expect(JSON.stringify(summary)).not.toContain("Xk92_mq7PzLw");

    // The upload and the extraction workspace are removed afterwards.
    await expect(stat(uploadPath(workspaceDir, key))).rejects.toThrow();
    expect(await readdir(path.join(workspaceDir, "runs"))).toEqual([]);
  });

  it("marks the analysis failed with a user-safe message when the archive is missing", async () => {
    const analysis = zipAnalysis(null);
    const { prisma } = fakePrisma(analysis);
    await runAnalysis("an1", { prisma, limits, log: silentLog });
    expect(analysis).toMatchObject({ status: "FAILED", error: "Uploaded archive is missing", finishedAt: expect.any(Date) });
  });

  it("marks the analysis failed (not stuck RUNNING) when clean-up of a previous attempt fails", async () => {
    const analysis = zipAnalysis(await stageUpload());
    const { prisma } = fakePrisma(analysis, { failOn: "finding.deleteMany" });
    await runAnalysis("an1", { prisma, limits, log: silentLog });
    expect(analysis).toMatchObject({ status: "FAILED", error: "Analysis failed due to an internal error" });
    expect(String(analysis.error)).not.toContain("simulated");
  });

  it("does not redo an analysis that already completed", async () => {
    const analysis = { ...zipAnalysis(null), status: "COMPLETED" };
    const { prisma, updates } = fakePrisma(analysis);
    await runAnalysis("an1", { prisma, limits, log: silentLog });
    expect(updates).toEqual([]);
  });
});
