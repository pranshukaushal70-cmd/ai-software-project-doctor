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
import { DEFAULT_DEMO_DIR, runAnalysis } from "./pipeline";

const FIXTURE = path.resolve(import.meta.dirname, "../../../packages/analyzer/test/fixtures/polyglot");
const FIXTURE_FILES = ["package.json", "README.md", "src/orders.ts", "src/format.ts", "src/utils/csv.js", "app/pipeline.py", "tests/orders.test.ts"];

type Row = Record<string, unknown>;

/** In-memory stand-in for the handful of Prisma calls the pipeline makes. */
function fakePrisma(analysis: Row, opts: { failOn?: string; triages?: Row[] } = {}) {
  const tables = {
    file: [] as Row[],
    finding: [] as Row[],
    metric: [] as Row[],
    dependency: [] as Row[],
    architectureNode: [] as Row[],
    architectureEdge: [] as Row[],
  };
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
    dependency: table("dependency"),
    architectureNode: table("architectureNode"),
    architectureEdge: table("architectureEdge"),
    findingTriage: {
      findMany: async ({ where }: { where: { repositoryId: string } }) => (opts.triages ?? []).filter((t) => t.repositoryId === where.repositoryId),
    },
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

async function stageZip(entries: Array<{ name: string; data: Buffer; deflate: boolean }>): Promise<string> {
  const key = randomUUID();
  await mkdir(uploadsDir(workspaceDir), { recursive: true });
  await writeFile(uploadPath(workspaceDir, key), buildZip(entries));
  return key;
}

async function stageUpload(): Promise<string> {
  const entries = await Promise.all(
    FIXTURE_FILES.map(async (rel) => ({ name: `polyglot-main/${rel}`, data: await readFile(path.join(FIXTURE, rel)), deflate: true })),
  );
  entries.push({ name: `polyglot-main/${ENV_FILE.path}`, data: Buffer.from(ENV_FILE.content), deflate: false });
  return stageZip(entries);
}

/** A small npm project with a lockfile and a two-file import cycle. */
const stageNpmProject = () =>
  stageZip(
    Object.entries({
      "package.json": JSON.stringify({ name: "shop", dependencies: { lodash: "^4.17.0" } }, null, 2),
      "package-lock.json": JSON.stringify(
        { lockfileVersion: 3, packages: { "": { name: "shop" }, "node_modules/lodash": { version: "4.17.20" } } },
        null,
        2,
      ),
      "src/a.ts": 'import _ from "lodash";\nimport { b } from "./b";\nexport const a = () => _.identity(b());\n',
      "src/b.ts": 'import { a } from "./a";\nexport const b = () => a;\n',
    }).map(([rel, text]) => ({ name: `shop-main/${rel}`, data: Buffer.from(text), deflate: true })),
  );

/** Fake OSV.dev reporting one advisory for lodash 4.17.20; records every request. */
function fakeOsv(mode: "ok" | "down" = "ok") {
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push(`${String(input)} ${typeof init?.body === "string" ? init.body : ""}`);
    if (mode === "down") throw new TypeError("fetch failed");
    if (String(input).endsWith("/querybatch")) {
      const { queries } = JSON.parse(init!.body as string) as { queries: Array<{ package: { name: string }; version: string }> };
      return Response.json({
        results: queries.map((q) => (q.package.name === "lodash" && q.version === "4.17.20" ? { vulns: [{ id: "GHSA-35jh-r3h4-6jhm" }] } : {})),
      });
    }
    return Response.json({
      id: "GHSA-35jh-r3h4-6jhm",
      aliases: ["CVE-2021-23337"],
      summary: "Command Injection in lodash",
      severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H" }],
      affected: [{ package: { ecosystem: "npm", name: "lodash" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }],
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
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
    const osv = fakeOsv();

    await runAnalysis("an1", { prisma, limits, log: silentLog, fetch: osv.fetch });

    expect(analysis).toMatchObject({ status: "COMPLETED", stage: "COMPLETED", progress: 100, analyzerVersion: expect.any(String) });
    expect(updates.map((u) => u.stage).filter(Boolean)).toEqual([
      "CLONING",
      "SCANNING",
      "PARSING",
      "SECURITY",
      "DEPENDENCIES",
      "ARCHITECTURE",
      "PRACTICES",
      "COMPLETED",
    ]);

    expect(tables.file.map((f) => f.path).sort()).toEqual([...ALL_FILES].sort());
    expect(tables.file.find((f) => f.path === "src/orders.ts")).toMatchObject({ kind: "SOURCE", loc: 62, maxComplexity: 15 });
    expect(tables.finding.some((f) => f.id === "stale")).toBe(false);
    expect(tables.finding.length).toBeGreaterThan(0);
    const fileIds = new Set(tables.file.map((f) => f.id));
    // Every finding links to its file, except repository-level ones (no README, no license …), which have no file.
    expect(tables.finding.every((f) => (f.fileId === null ? f.analyzer === "practices" : fileIds.has(f.fileId as string)))).toBe(true);
    expect(tables.metric.find((m) => m.key === "code.files")?.value).toBe(5);

    // Security findings are persisted next to code-quality findings, linked to their file.
    const envFileId = tables.file.find((f) => f.path === ".env")?.id;
    const secrets = tables.finding.filter((f) => f.category === "SECRET");
    expect(secrets.map((f) => f.ruleId).sort()).toEqual(["secret/committed-env-file", "secret/hardcoded-credential"]);
    expect(secrets.every((f) => f.fileId === envFileId && f.analyzer === "security")).toBe(true);
    expect(JSON.stringify(tables.finding)).not.toContain("Xk92_mq7PzLw");
    expect(tables.metric.find((m) => m.key === "security.secrets")?.value).toBe(2);

    // The fixture's package.json declares a dev dependency without a lockfile: nothing to query, one hygiene finding.
    expect(osv.requests).toEqual([]);
    const packageJsonId = tables.file.find((f) => f.path === "package.json")?.id;
    expect(tables.finding.filter((f) => f.category === "DEPENDENCY")).toEqual([
      expect.objectContaining({ ruleId: "dependency/missing-lockfile", severity: "LOW", fileId: packageJsonId, analyzer: "dependencies" }),
    ]);
    expect(tables.dependency).toEqual([expect.objectContaining({ analysisId: "an1", ecosystem: "npm", name: "vitest", dev: true, vulnIds: [] })]);

    // The import graph is persisted with edges pointing at stored node ids.
    const nodeById = new Map(tables.architectureNode.map((n) => [n.id, n.key]));
    const importEdges = tables.architectureEdge.filter((e) => e.kind === "import").map((e) => `${nodeById.get(e.fromId as string)} -> ${nodeById.get(e.toId as string)}`);
    expect(importEdges).toContain("file:src/orders.ts -> file:src/format.ts");
    expect(tables.architectureEdge.every((e) => nodeById.has(e.fromId as string) && nodeById.has(e.toId as string))).toBe(true);
    expect(tables.metric.find((m) => m.key === "architecture.cycles")?.value).toBe(0);
    expect(tables.metric.find((m) => m.key === "dependencies.total")?.value).toBe(1);

    const summary = analysis.summary as {
      modulesRun: string[];
      ingest: Row;
      codeMetrics: { totals: Row };
      security: { totals: Row; envFiles: string[] };
      dependencies: { vulnerabilityScan: Row; totals: Row };
      architecture: { totals: Row };
    };
    expect(summary.modulesRun).toEqual(["repository-scan", "code-metrics", "security", "dependencies", "architecture", "practices", "health-score"]);

    // Phase 5: practices findings and an explainable health score.
    const practices = (analysis.summary as { practices: { testing: Row; findings: { byCategory: Row } } }).practices;
    expect(practices.testing).toMatchObject({ testFiles: 1, testCases: expect.any(Number) });
    expect(tables.finding.some((f) => f.ruleId === "documentation/missing-license" && f.fileId === null && f.analyzer === "practices")).toBe(true);
    const breakdown = analysis.scoreBreakdown as { score: number; grade: string; dimensions: Array<{ id: string; score: number | null; factors: unknown[] }> };
    expect(analysis.healthScore).toBe(breakdown.score);
    expect(breakdown.grade).toMatch(/^[ABCDF]$/);
    expect(breakdown.dimensions.find((d) => d.id === "security")!.factors.length).toBeGreaterThan(0);
    expect(breakdown.dimensions.find((d) => d.id === "api")!.score).toBeNull();
    expect(analysis.weightsUsed).toMatchObject({ version: "1.0" });
    expect(tables.metric.find((m) => m.key === "score.overall")?.value).toBe(analysis.healthScore);
    expect(summary.dependencies.vulnerabilityScan).toMatchObject({ status: "skipped", queried: 0 });
    expect(summary.architecture.totals).toMatchObject({ cycles: 0 });
    expect(summary.ingest).toMatchObject({ source: "ZIP", extractedFiles: ALL_FILES.length });
    expect(summary.security.totals).toMatchObject({ secrets: 2 });
    expect(summary.security.envFiles).toEqual([".env"]);
    expect(JSON.stringify(summary)).not.toContain(workspaceDir);
    expect(JSON.stringify(summary)).not.toContain("Xk92_mq7PzLw");

    // The upload and the extraction workspace are removed afterwards.
    await expect(stat(uploadPath(workspaceDir, key))).rejects.toThrow();
    expect(await readdir(path.join(workspaceDir, "runs"))).toEqual([]);
  });

  it("persists dependencies with OSV.dev advisories and an import cycle", async () => {
    const analysis = zipAnalysis(await stageNpmProject());
    const { prisma, tables } = fakePrisma(analysis);
    // Rows from an interrupted attempt are replaced, not duplicated.
    tables.dependency.push({ id: "staleDep", analysisId: "an1" });
    tables.architectureNode.push({ id: "staleNode", analysisId: "an1", key: "file:gone.ts" });
    tables.architectureEdge.push({ id: "staleEdge", analysisId: "an1", fromId: "staleNode", toId: "staleNode" });
    const osv = fakeOsv();

    await runAnalysis("an1", { prisma, limits, log: silentLog, fetch: osv.fetch });

    expect(analysis).toMatchObject({ status: "COMPLETED" });
    expect([...tables.dependency, ...tables.architectureNode, ...tables.architectureEdge].some((r) => String(r.id).startsWith("stale"))).toBe(false);
    expect(osv.requests.map((r) => r.split(" ")[0])).toEqual(["https://api.osv.dev/v1/querybatch", "https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm"]);

    expect(tables.dependency).toEqual([
      expect.objectContaining({ name: "lodash", versionSpec: "^4.17.0", resolvedVersion: "4.17.20", direct: true, vulnIds: ["GHSA-35jh-r3h4-6jhm"], dataSource: "osv.dev" }),
    ]);
    const vuln = tables.finding.find((f) => f.ruleId === "dependency/known-vulnerability")!;
    expect(vuln).toMatchObject({
      category: "DEPENDENCY",
      severity: "HIGH",
      fileId: tables.file.find((f) => f.path === "package.json")?.id,
      recommendation: "Upgrade lodash to 4.17.21 or later.",
    });
    expect(vuln.evidence).toContain("CVE-2021-23337");

    const cycle = tables.finding.find((f) => f.ruleId === "architecture/circular-dependency")!;
    expect(cycle).toMatchObject({ category: "ARCHITECTURE", severity: "MEDIUM", line: null, fileId: tables.file.find((f) => f.path === "src/a.ts")?.id });
    expect(cycle.evidence).toBe("`src/a.ts` → `src/b.ts` → `src/a.ts`.");
    expect(tables.architectureEdge.filter((e) => e.kind === "import" && e.inCycle)).toHaveLength(2);
    expect(tables.metric.find((m) => m.key === "dependencies.vulnerable.high")?.value).toBe(1);
    expect(tables.metric.find((m) => m.key === "architecture.cycles")?.value).toBe(1);
  });

  it("completes when OSV.dev is unreachable and records the outage", async () => {
    const analysis = zipAnalysis(await stageNpmProject());
    const { prisma, tables } = fakePrisma(analysis);
    await runAnalysis("an1", { prisma, limits, log: silentLog, fetch: fakeOsv("down").fetch });
    expect(analysis).toMatchObject({ status: "COMPLETED" });
    const summary = analysis.summary as { dependencies: { vulnerabilityScan: Row } };
    expect(summary.dependencies.vulnerabilityScan).toMatchObject({ status: "failed", error: "OSV.dev could not be reached" });
    expect(tables.dependency[0]).toMatchObject({ name: "lodash", vulnIds: [], dataSource: null });
    expect(tables.finding.some((f) => f.ruleId === "dependency/known-vulnerability")).toBe(false);
  });

  it("makes no OSV.dev request when the lookup is disabled", async () => {
    const analysis = zipAnalysis(await stageNpmProject());
    const { prisma } = fakePrisma(analysis);
    const osv = fakeOsv();
    await runAnalysis("an1", { prisma, limits: { ...limits, osvEnabled: false }, log: silentLog, fetch: osv.fetch });
    expect(analysis).toMatchObject({ status: "COMPLETED" });
    expect(osv.requests).toEqual([]);
    expect((analysis.summary as { dependencies: { vulnerabilityScan: Row } }).dependencies.vulnerabilityScan).toMatchObject({ status: "disabled" });
  });

  it("marks the analysis failed with a user-safe message when the archive is missing", async () => {
    const analysis = zipAnalysis(null);
    const { prisma } = fakePrisma(analysis);
    await runAnalysis("an1", { prisma, limits, log: silentLog });
    expect(analysis).toMatchObject({ status: "FAILED", error: "Uploaded archive is missing", finishedAt: expect.any(Date) });
  });

  it("marks the analysis failed (not stuck RUNNING) when clean-up of a previous attempt fails", async () => {
    const analysis = zipAnalysis(await stageUpload());
    const { prisma } = fakePrisma(analysis, { failOn: "dependency.deleteMany" });
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
  it("analyses the bundled demo project without touching it", async () => {
    const analysis: Row = { id: "an1", status: "QUEUED", repository: { id: "demo1", source: "DEMO", url: null, branch: null, uploadKey: null } };
    const { prisma, tables } = fakePrisma(analysis);
    await runAnalysis("an1", { prisma, limits, log: silentLog, fetch: fakeOsv().fetch });

    expect(analysis).toMatchObject({ status: "COMPLETED", error: null });
    expect((analysis.summary as { ingest: Row }).ingest).toEqual({ source: "DEMO", demo: "storefront" });
    // Manifests get their real names in the workspace copy only.
    expect(tables.file.map((f) => f.path)).toEqual(expect.arrayContaining(["package.json", "package-lock.json"]));
    expect(tables.file.some((f) => String(f.path).endsWith(".demo"))).toBe(false);
    expect(await readdir(DEFAULT_DEMO_DIR)).toEqual(expect.arrayContaining(["package.json.demo", "package-lock.json.demo"]));
    expect(await readdir(DEFAULT_DEMO_DIR)).not.toContain("package.json");

    // Every module finds the issues planted in the demo (see demo/README.md).
    const ruleIds = new Set(tables.finding.map((f) => f.ruleId));
    for (const id of [
      "secret/hardcoded-credential",
      "injection/sql",
      "crypto/weak-hash",
      "dependency/known-vulnerability",
      "architecture/circular-dependency",
      "complexity/high-cyclomatic",
      "api/permissive-cors",
      "api/unauthenticated-mutation",
      "api/missing-input-validation",
      "api/error-details-exposed",
      "api/auth-without-rate-limit",
      "database/unindexed-foreign-key",
      "database/no-migrations",
      "testing/skipped-test",
      "testing/tests-not-in-ci",
      "documentation/incomplete-readme",
      "documentation/broken-link",
      "documentation/missing-license",
      "documentation/undocumented-env-vars",
    ]) {
      expect(ruleIds, id).toContain(id);
    }
    expect(JSON.stringify(tables.finding)).not.toContain("Sup3r-Secret-Admin-Pw");
    expect(analysis.healthScore).toBeLessThan(75);
    expect(await readdir(path.join(workspaceDir, "runs"))).toEqual([]);
  });

  it("fails with a clear message when the demo project is missing", async () => {
    const analysis: Row = { id: "an1", status: "QUEUED", repository: { id: "demo1", source: "DEMO", url: null, branch: null, uploadKey: null } };
    const { prisma } = fakePrisma(analysis);
    await runAnalysis("an1", { prisma, limits, log: silentLog, demoDir: path.join(workspaceDir, "no-such-demo") });
    expect(analysis).toMatchObject({ status: "FAILED", error: "The demo project is not available on this server" });
  });

  it("leaves findings triaged for the repository out of the health score", async () => {
    const first = zipAnalysis(await stageUpload());
    const run1 = fakePrisma(first);
    await runAnalysis("an1", { prisma: run1.prisma, limits, log: silentLog });
    const secret = run1.tables.finding.find((f) => f.ruleId === "secret/hardcoded-credential")!;

    const second = zipAnalysis(await stageUpload());
    const triages = [{ repositoryId: "repo1", fingerprint: secret.fingerprint, status: "EXPECTED" }, { repositoryId: "other", fingerprint: "x", status: "IGNORED" }];
    const run2 = fakePrisma(second, { triages });
    await runAnalysis("an1", { prisma: run2.prisma, limits, log: silentLog });

    const breakdown = second.scoreBreakdown as { excludedFindings: number; caveats: string[] };
    expect(breakdown.excludedFindings).toBe(1);
    expect(breakdown.caveats).toContain("1 finding triaged as Expected or Ignored was not counted.");
    expect(second.healthScore as number).toBeGreaterThan(first.healthScore as number);
    // The triaged finding is still reported.
    expect(run2.tables.finding.some((f) => f.fingerprint === secret.fingerprint)).toBe(true);
  });
});
