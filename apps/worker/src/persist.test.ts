import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { scanRepository, type RepositoryScan } from "@pd/analyzer";
import { analyzeCode, type CodeAnalysis } from "@pd/analyzer/metrics";
import { createSecurityScanner, type SecurityAnalysis } from "@pd/analyzer/security";
import { buildFileRows, buildFindingRows, buildRepositoryMetricRows, buildSecurityMetricRows } from "./persist";
import { summarizeScan } from "./summary";

const FIXTURE = path.resolve(import.meta.dirname, "../../../packages/analyzer/test/fixtures/polyglot");

let scan: RepositoryScan;
let code: CodeAnalysis;
let sec: SecurityAnalysis;

beforeAll(async () => {
  scan = await scanRepository(FIXTURE, { maxFileBytes: 1024 * 1024 });
  const security = createSecurityScanner();
  code = await analyzeCode(scan.files, { onTree: security.inspectTree });
  sec = await security.finish(scan);
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

describe("summarizeScan", () => {
  it("records the code-metrics and security modules and their summaries", () => {
    const summary = summarizeScan(scan, { source: "ZIP" }, code.summary, sec.summary);
    expect(summary.modulesRun).toEqual(["repository-scan", "code-metrics", "security"]);
    expect(summary.security.analyzer).toBe("security");
    expect(summary.codeMetrics.totals.filesAnalyzed).toBe(11);
    // Must be JSON-serialisable for the Analysis.summary column.
    expect(JSON.parse(JSON.stringify(summary)).codeMetrics.thresholds.complexity.medium).toBe(10);
  });
});
