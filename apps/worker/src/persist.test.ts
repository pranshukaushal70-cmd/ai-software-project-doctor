import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { scanRepository, type RepositoryScan } from "@pd/analyzer";
import { analyzeArchitecture, type ArchitectureAnalysis } from "@pd/analyzer/architecture";
import { analyzeDependencies, type DependencyAnalysis } from "@pd/analyzer/dependencies";
import { analyzeCode, type CodeAnalysis } from "@pd/analyzer/metrics";
import { createSecurityScanner, type SecurityAnalysis } from "@pd/analyzer/security";
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
import { summarizeScan } from "./summary";

const FIXTURE = path.resolve(import.meta.dirname, "../../../packages/analyzer/test/fixtures/polyglot");

let scan: RepositoryScan;
let code: CodeAnalysis;
let sec: SecurityAnalysis;
let dep: DependencyAnalysis;
let arch: ArchitectureAnalysis;

beforeAll(async () => {
  scan = await scanRepository(FIXTURE, { maxFileBytes: 1024 * 1024 });
  const security = createSecurityScanner();
  code = await analyzeCode(scan.files, { onTree: security.inspectTree });
  sec = await security.finish(scan);
  const imports = code.files.map((f) => ({ path: f.path, language: f.language, imports: f.metrics.imports, codeLines: f.metrics.codeLines }));
  dep = await analyzeDependencies(scan.files, { imports });
  arch = await analyzeArchitecture(scan.files, imports, new Map(scan.files.map((f) => [f.path, f.kind])));
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
    const summary = summarizeScan(scan, { source: "ZIP" }, code.summary, sec.summary, dep.summary, arch.summary);
    expect(summary.modulesRun).toEqual(["repository-scan", "code-metrics", "security", "dependencies", "architecture"]);
    expect(summary.security.analyzer).toBe("security");
    expect(summary.dependencies.analyzer).toBe("dependencies");
    expect(summary.architecture.analyzer).toBe("architecture");
    expect(summary.codeMetrics.totals.filesAnalyzed).toBe(11);
    // Must be JSON-serialisable for the Analysis.summary column.
    expect(JSON.parse(JSON.stringify(summary)).codeMetrics.thresholds.complexity.medium).toBe(10);
  });
});
