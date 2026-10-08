import { cp, mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ANALYZER_VERSION } from "@pd/analyzer";
import { runAnalyzers } from "@pd/analyzer/run";
import { loadLimits } from "@pd/shared";
import { type Fixture } from "./ground-truth";
import { aggregate, type FixtureScore, scoreFixture, type ScoredFinding } from "./score";

/**
 * Issue-detection benchmark: runs exactly the analyzer modules the worker runs
 * (@pd/analyzer/run) on every fixture, offline (no OSV.dev lookup), and scores the
 * findings against the ground truth. The result is deterministic, so it is committed
 * (results/detection.json) and CI checks that it is unchanged.
 */

export interface DetectionResult {
  benchmark: "detection";
  analyzerVersion: string;
  osv: "disabled";
  fixtures: Array<{ name: string; description: string; labeledCategories: string[]; expected: number; findings: number; health: { score: number; grade: string }; score: FixtureScore }>;
  overall: ReturnType<typeof aggregate>["overall"];
  categories: ReturnType<typeof aggregate>["categories"];
  rules: ReturnType<typeof aggregate>["rules"];
}

// Categories of rules that were expected but never reported, for the per-category table.
const PREFIX_CATEGORY: Record<string, string> = {
  secret: "SECRET",
  injection: "SECURITY",
  crypto: "SECURITY",
  unsafe: "SECURITY",
  config: "SECURITY",
  memory: "SECURITY",
  complexity: "CODE_QUALITY",
  size: "CODE_QUALITY",
  smell: "CODE_QUALITY",
  duplication: "CODE_QUALITY",
  dependency: "DEPENDENCY",
  architecture: "ARCHITECTURE",
  api: "API",
  database: "DATABASE",
  testing: "TESTING",
  documentation: "DOCUMENTATION",
};

const silent = { info() {}, warn() {} };

/** A private copy of the fixture's source, with `.demo` names restored like the worker does for the demo. */
async function materialize(fixture: Fixture): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `pd-bench-${fixture.truth.name}-`));
  await cp(fixture.sourceDir, dir, { recursive: true });
  for (const [from, to] of Object.entries(fixture.truth.source.rename ?? {})) await rename(path.join(dir, from), path.join(dir, to));
  return dir;
}

export async function runDetection(fixtures: readonly Fixture[]): Promise<DetectionResult> {
  const { maxFileBytes } = loadLimits({});
  const ruleCategory = new Map<string, string>();
  const rows: DetectionResult["fixtures"] = [];
  for (const fixture of fixtures) {
    const dir = await materialize(fixture);
    try {
      const result = await runAnalyzers(dir, { name: fixture.truth.name, maxFileBytes, log: silent });
      const findings: ScoredFinding[] = result.findings.map((f) => ({ ruleId: f.ruleId, category: f.category, path: f.path ?? null, line: f.line ?? null }));
      for (const f of findings) ruleCategory.set(f.ruleId, f.category);
      rows.push({
        name: fixture.truth.name,
        description: fixture.truth.description,
        labeledCategories: fixture.truth.labeledCategories,
        expected: fixture.truth.expected.length,
        findings: findings.length,
        health: { score: result.health.score, grade: result.health.grade },
        score: scoreFixture(fixture.truth, findings),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  for (const f of fixtures) {
    for (const e of f.truth.expected) if (!ruleCategory.has(e.ruleId)) ruleCategory.set(e.ruleId, PREFIX_CATEGORY[e.ruleId.split("/")[0]!] ?? "UNKNOWN");
  }
  return { benchmark: "detection", analyzerVersion: ANALYZER_VERSION, osv: "disabled", fixtures: rows, ...aggregate(rows.map((r) => r.score), ruleCategory) };
}
