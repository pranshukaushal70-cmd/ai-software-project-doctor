import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { scanRepository, type RepositoryScan } from "@pd/analyzer";
import { analyzeArchitecture, type ArchitectureAnalysis } from "@pd/analyzer/architecture";
import { analyzeDependencies, type DependencyAnalysis } from "@pd/analyzer/dependencies";
import { buildRepositoryIndex, createSymbolCollector, type RepositoryIndex } from "@pd/analyzer/intelligence";
import { analyzeCode, type CodeAnalysis } from "@pd/analyzer/metrics";
import { analyzePractices, type PracticesAnalysis } from "@pd/analyzer/practices";
import { computeHealthScore } from "@pd/analyzer/scoring";
import { createSecurityScanner, type SecurityAnalysis } from "@pd/analyzer/security";
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
import { summarizeScan } from "./summary";

const FIXTURE = path.resolve(import.meta.dirname, "../../../packages/analyzer/test/fixtures/polyglot");

let scan: RepositoryScan;
let code: CodeAnalysis;
let sec: SecurityAnalysis;
let dep: DependencyAnalysis;
let arch: ArchitectureAnalysis;
let practices: PracticesAnalysis;
let index: RepositoryIndex;

beforeAll(async () => {
  scan = await scanRepository(FIXTURE, { maxFileBytes: 1024 * 1024 });
  const security = createSecurityScanner();
  const symbols = createSymbolCollector();
  code = await analyzeCode(scan.files, { onTree: (ctx) => (security.inspectTree(ctx), symbols.inspectTree(ctx)) });
  sec = await security.finish(scan);
  const imports = code.files.map((f) => ({ path: f.path, language: f.language, imports: f.metrics.imports, codeLines: f.metrics.codeLines }));
  dep = await analyzeDependencies(scan.files, { imports });
  arch = await analyzeArchitecture(scan.files, imports, new Map(scan.files.map((f) => [f.path, f.kind])));
  practices = await analyzePractices(scan, code);
  index = await buildRepositoryIndex(scan, code, symbols.files(), { name: "polyglot", moduleDepth: arch.summary.moduleDepth });
});

describe("buildFileRows", () => {
  it("merges code metrics into analysed files and leaves other files without metrics", () => {
    const rows = buildFileRows("a1", scan, code);
    expect(rows).toHaveLength(scan.files.length);
    const orders = rows.find((r) => r.path === "src/orders.ts");
    expect(orders).toMatchObject({
      analysisId: "a1",
      kind: "SOURCE",
      lines: 72,
      loc: 62,
      commentLines: 4,
      blankLines: 6,
      functionCount: 3,
      classCount: 1,
      maxComplexity: 15,
      maxNesting: 5,
      imports: ["node:fs/promises", "./format"],
    });
    const readme = rows.find((r) => r.path === "README.md");
    expect(readme).toBeDefined();
    expect(readme!.loc).toBeUndefined();
    expect(readme!.imports).toBeUndefined();
  });
});

describe("buildFindingRows", () => {
  it("links findings to file ids and keeps every evidence field", () => {
    const ids = new Map(scan.files.map((f, i) => [f.path, `file${i}`]));
    const rows = buildFindingRows("a1", code.findings, ids);
    expect(rows).toHaveLength(code.findings.length);
    for (const row of rows) {
      expect(row.fileId).toMatch(/^file\d+$/);
      expect(row).toMatchObject({ analysisId: "a1", category: "CODE_QUALITY", analyzer: "code-metrics" });
      for (const key of ["type", "severity", "ruleId", "title", "evidence", "impact", "recommendation", "fingerprint", "analyzerVersion"] as const) {
        expect(row[key]).toBeTruthy();
      }
      expect(row.line).toBeGreaterThan(0);
    }
  });

  it("stores security findings with their own category and analyzer", () => {
    const ids = new Map(scan.files.map((f, i) => [f.path, `file${i}`]));
    const rows = buildFindingRows("a1", [...code.findings, ...sec.findings], ids);
    expect(rows).toHaveLength(code.findings.length + sec.findings.length);
    const securityRows = rows.filter((r) => r.analyzer === "security");
    expect(securityRows.length).toBe(sec.findings.length);
    for (const row of securityRows) {
      expect(["SECURITY", "SECRET"]).toContain(row.category);
      expect(row.data).toMatchObject({ cwe: expect.stringMatching(/^CWE-/) });
    }
  });

  it("stores dependency and architecture findings, which may have no line", () => {
    const ids = new Map(scan.files.map((f, i) => [f.path, `file${i}`]));
    const rows = buildFindingRows("a1", [...dep.findings, ...arch.findings], ids);
    expect(rows.length).toBe(dep.findings.length + arch.findings.length);
    const lockfile = rows.find((r) => r.ruleId === "dependency/missing-lockfile");
    expect(lockfile).toMatchObject({ category: "DEPENDENCY", fileId: ids.get("package.json"), line: null, analyzer: "dependencies" });
  });

  it("tolerates findings whose file is unknown", () => {
    const rows = buildFindingRows("a1", code.findings.slice(0, 1), new Map());
    expect(rows[0]!.fileId).toBeNull();
  });
});

describe("buildRepositoryMetricRows", () => {
  it("stores repository-level aggregates", () => {
    const rows = buildRepositoryMetricRows("a1", code);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey).toMatchObject({
      "code.files": 11,
      "complexity.max": 15,
      "findings.code_quality": code.findings.length,
      "findings.code_quality.medium": 13,
    });
    expect(rows.every((r) => r.analysisId === "a1" && Number.isFinite(r.value))).toBe(true);
  });
});

describe("buildSecurityMetricRows", () => {
  it("stores security aggregates by severity", () => {
    const rows = buildSecurityMetricRows("a1", sec);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey["security.findings"]).toBe(sec.summary.totals.findings);
    expect(byKey["security.secrets"]! + byKey["security.insecure_patterns"]!).toBe(byKey["security.findings"]);
    expect(Object.keys(byKey)).toEqual(expect.arrayContaining(["security.findings.critical", "security.findings.info"]));
  });
});

describe("buildDependencyRows", () => {
  it("maps analysed dependencies onto the Dependency table", () => {
    const rows = buildDependencyRows("a1", dep.dependencies);
    expect(rows).toEqual([
      {
        analysisId: "a1",
        ecosystem: "npm",
        name: "vitest",
        versionSpec: "^5.0.0",
        resolvedVersion: null,
        direct: true,
        dev: true,
        manifestPath: "package.json",
        vulnIds: [],
        dataSource: null,
        unusedCandidate: false,
      },
    ]);
  });
});

describe("buildArchitectureNodeRows / buildArchitectureEdgeRows", () => {
  it("stores nodes and links edges through inserted node ids", () => {
    const nodes = buildArchitectureNodeRows("a1", arch.nodes);
    expect(nodes.length).toBe(arch.nodes.length);
    expect(nodes.find((n) => n.key === "file:src/orders.ts")).toMatchObject({ kind: "FILE", label: "src/orders.ts", metrics: { fanOut: 1 } });
    expect(nodes.some((n) => n.kind === "MODULE")).toBe(true);

    const ids = new Map(nodes.map((n, i) => [n.key, `node${i}`]));
    const edges = buildArchitectureEdgeRows("a1", arch.edges, ids);
    expect(edges.length).toBe(arch.edges.length);
    expect(edges).toContainEqual({ analysisId: "a1", fromId: ids.get("file:src/orders.ts"), toId: ids.get("file:src/format.ts"), kind: "import", weight: 1, inCycle: false });
  });

  it("drops edges whose nodes were not stored", () => {
    const edges = buildArchitectureEdgeRows("a1", [{ from: "file:a.ts", to: "file:b.ts", kind: "import", weight: 1, inCycle: false }], new Map([["file:a.ts", "n1"]]));
    expect(edges).toEqual([]);
  });
});

describe("buildDependencyMetricRows / buildArchitectureMetricRows", () => {
  it("stores dependency and architecture aggregates", () => {
    const depMetrics = Object.fromEntries(buildDependencyMetricRows("a1", dep).map((r) => [r.key, r.value]));
    expect(depMetrics).toMatchObject({ "dependencies.total": 1, "dependencies.dev": 1, "dependencies.vulnerable": 0, "findings.dependency": dep.findings.length });
    expect(Object.keys(depMetrics)).toEqual(expect.arrayContaining(["dependencies.vulnerable.critical", "dependencies.vulnerable.info"]));
    const archMetrics = Object.fromEntries(buildArchitectureMetricRows("a1", arch).map((r) => [r.key, r.value]));
    expect(archMetrics).toMatchObject({ "architecture.files": arch.summary.totals.files, "architecture.cycles": 0 });
    expect([...Object.values(depMetrics), ...Object.values(archMetrics)].every(Number.isFinite)).toBe(true);
  });
});

describe("summarizeScan", () => {
  it("records every module that ran and its summary", () => {
    const summary = summarizeScan(scan, { source: "ZIP" }, code.summary, sec.summary, dep.summary, arch.summary, practices.summary, index.summary);
    expect(summary.modulesRun).toEqual(["repository-scan", "code-metrics", "security", "dependencies", "architecture", "practices", "health-score", "intelligence"]);
    expect(summary.practices.analyzer).toBe("practices");
    // The manifest prefers the name in package.json over the repository name.
    expect(summary.intelligence.manifest.name).toBe("polyglot-demo");
    expect(summary.security.analyzer).toBe("security");
    expect(summary.dependencies.analyzer).toBe("dependencies");
    expect(summary.architecture.analyzer).toBe("architecture");
    expect(summary.codeMetrics.totals.filesAnalyzed).toBe(11);
    // Must be JSON-serialisable for the Analysis.summary column.
    expect(JSON.parse(JSON.stringify(summary)).codeMetrics.thresholds.complexity.medium).toBe(10);
  });
});

describe("buildPracticeMetricRows / buildScoreMetricRows", () => {
  it("stores API, database, testing and documentation aggregates", () => {
    const m = Object.fromEntries(buildPracticeMetricRows("a1", practices).map((r) => [r.key, r.value]));
    expect(m).toMatchObject({ "testing.test_files": 1, "api.endpoints": 0, "database.models": 0, "findings.testing": practices.summary.findings.byCategory.TESTING });
    expect(m["testing.test_ratio"]).toBeGreaterThan(0);
    expect(m).not.toHaveProperty("testing.coverage_lines");
    expect(Object.values(m).every(Number.isFinite)).toBe(true);
  });

  it("stores the overall score and only the dimensions that apply", () => {
    const health = computeHealthScore({ findings: [], productionCodeLines: 100, present: { code: true, dependencies: true, architecture: true, api: false, database: false } });
    const m = Object.fromEntries(buildScoreMetricRows("a1", health).map((r) => [r.key, r.value]));
    expect(m).toMatchObject({ "score.overall": 100, "score.security": 100, "score.testing": 100 });
    expect(m).not.toHaveProperty("score.api");
  });
});

describe("repository index rows", () => {
  it("stores file content hashes", () => {
    const rows = buildFileRows("a1", scan, code);
    expect(rows.find((r) => r.path === "src/orders.ts")?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps dependencies, symbols and references to stored ids and drops rows whose file is missing", () => {
    const fileIds = new Map(scan.files.map((f, i) => [f.path, `file${i}`]));
    const deps = buildFileDependencyRows("a1", index.dependencies, fileIds);
    expect(deps).toContainEqual(expect.objectContaining({ fromFileId: fileIds.get("src/orders.ts"), toFileId: fileIds.get("src/format.ts"), kind: "INTERNAL" }));
    expect(deps.every((d) => d.kind !== "INTERNAL" || d.toFileId)).toBe(true);
    const withoutOrders = new Map([...fileIds].filter(([p]) => p !== "src/orders.ts"));
    expect(buildFileDependencyRows("a1", index.dependencies, withoutOrders).some((d) => d.fromFileId === fileIds.get("src/orders.ts"))).toBe(false);

    const symbols = buildSymbolRows("a1", index.symbols, fileIds);
    expect(symbols.length).toBe(index.symbols.length);
    expect(new Set(symbols.map((s) => s.key)).size).toBe(symbols.length);
    const symbolIds = new Map(symbols.map((s, i) => [s.key, `sym${i}`]));
    const refs = buildReferenceRows("a1", index.references, fileIds, symbolIds);
    expect(refs.length).toBe(index.references.length);
    expect(refs.filter((r) => r.targetSymbolId).length).toBe(index.references.filter((r) => r.targetKey).length);
  });

  it("stores index sizes as metrics", () => {
    const m = Object.fromEntries(buildIntelligenceMetricRows("a1", index).map((r) => [r.key, r.value]));
    expect(m["intelligence.symbols"]).toBe(index.summary.totals.symbols);
    expect(Object.values(m).every(Number.isFinite)).toBe(true);
  });
});
