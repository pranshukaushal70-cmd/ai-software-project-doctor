import { snippet } from "../metrics/evidence";
import type { Detection } from "../scanner";
import { PRACTICE_THRESHOLDS } from "./rules";
import { basename, dirname, type RawPracticeFinding, type TextFile } from "./types";

/**
 * Testing analysis: how much test code exists, whether it runs automatically,
 * and what committed coverage reports say. Coverage is only reported when a
 * report exists; it is never estimated.
 */

export interface TestingSummary {
  testFiles: number;
  testCases: number;
  sourceFiles: number;
  testCodeLines: number;
  sourceCodeLines: number;
  /** testCodeLines ÷ sourceCodeLines (2 decimals); null without production code. */
  testRatio: number | null;
  frameworks: Array<{ name: string; evidence: string }>;
  /** Root package.json `scripts.test`, when there is a root package.json. */
  testScript: string | null;
  ci: { configured: boolean; runsTests: boolean; evidence: string | null };
  coverage: { path: string; format: string; linePercent: number } | null;
  focused: number;
  skipped: number;
  /** Production files that a test imports or is named after. */
  referencedSourceFiles: number;
  /** Largest production files no test refers to. */
  untested: Array<{ path: string; codeLines: number }>;
}

export interface TestingInput {
  /** Repository files with their kind, language and code lines (code metrics where available, else physical lines). */
  files: ReadonlyArray<{ path: string; kind: TextFile["kind"]; language: string | null; codeLines: number; imports: readonly string[]; analyzed: boolean }>;
  /** Text of test files, CI configuration and the root package.json. */
  texts: readonly TextFile[];
  /** Coverage reports found in the repository. */
  coverageReports: readonly TextFile[];
  frameworks: readonly Detection[];
  ci: readonly Detection[];
}

const DEFAULT_NPM_TEST = /no test specified/;
const TEST_COMMAND =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|\bnpx\s+(?:vitest|jest|mocha|playwright|cypress)\b|\b(?:vitest|jest|mocha|pytest|tox|nox|phpunit|rspec|ctest)\b|\bpython\d?\s+-m\s+(?:pytest|unittest)\b|\bmvnw?\b[^\n]*\b(?:test|verify|install|package)\b|\bgradlew?\b[^\n]*\b(?:test|check|build)\b|\bgo\s+test\b|\bcargo\s+test\b|\bdotnet\s+test\b|\bmake\s+(?:test|check)\b|\bturbo\s+(?:run\s+)?test\b/i;
const CI_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$|^\.gitlab-ci\.yml$|^Jenkinsfile$|^\.circleci\/config\.yml$|^azure-pipelines\.yml$|^\.travis\.yml$|^bitbucket-pipelines\.yml$/;

const TEST_CASE: Record<string, RegExp> = {
  // `xit`/`fit` are skipped/focused test cases, still test cases.
  js: /\b[xf]?(?:it|test)(?:\.(?:each\s*\([^)]*\)|concurrent|only|skip|todo|failing))*\s*\(\s*['"`]/g,
  python: /^\s*(?:async\s+)?def\s+test_\w*\s*\(/gm,
  java: /@(?:Test|ParameterizedTest|RepeatedTest)\b/g,
  c: /\bTEST(?:_F|_P)?\s*\(/g,
  go: /^func\s+Test\w*\s*\(/gm,
};
const FOCUSED: Record<string, RegExp> = {
  js: /\b(?:it|test|describe|context)\.only\s*\(|\bf(?:it|describe)\s*\(/,
};
const SKIPPED: Record<string, RegExp> = {
  js: /\b(?:it|test|describe|context)\.skip\s*\(|\bx(?:it|describe|test)\s*\(/,
  python: /@pytest\.mark\.skip(?!if)\b|@unittest\.skip\b(?!If|Unless)/,
  java: /@Disabled\b|@Ignore\b/,
};
const group = (language: string | null) =>
  language === "javascript" || language === "typescript" ? "js" : language === "c" || language === "cpp" ? "c" : language;

/** Name a test is about: `orders.test.ts` → orders, `test_pipeline.py` → pipeline, `InventoryServiceTest.java` → inventoryservice. */
function testedStem(path: string): string {
  return basename(path)
    .replace(/\.[^.]+$/, "")
    .replace(/\.(?:test|spec|e2e|cy)$/i, "")
    .replace(/^test_|_test$/i, "")
    .replace(/(?<=\w)Tests?$/, "")
    .toLowerCase();
}

/** A source file's stem; `index`/`__init__`/`mod` files are named after their directory. */
function sourceStem(path: string): string {
  const stem = basename(path).replace(/\.[^.]+$/, "").toLowerCase();
  return /^(?:index|__init__|mod|main)$/.test(stem) ? basename(dirname(path)).toLowerCase() : stem;
}

/** The module a specifier names: "../src/orders.js" → orders, "app.pipeline" → pipeline, "com.demo.InventoryService" → inventoryservice. */
function specifierStem(spec: string): string {
  if (/[/\\]/.test(spec)) return (spec.split(/[/\\]/).pop() ?? spec).replace(/\.[cm]?[jt]sx?$|\.py$/, "").toLowerCase();
  // Dotted module names: Python (`app.pipeline`, relative `.orders`) and Java (`com.demo.InventoryService`).
  return (spec.split(".").filter(Boolean).pop() ?? spec).toLowerCase();
}

export function parseCoverage(path: string, text: string): { format: string; linePercent: number } | null {
  const name = basename(path).toLowerCase();
  const round = (n: number) => Math.round(n * 10) / 10;
  if (name.endsWith(".info") || name === "lcov.info") {
    let found = 0;
    let hit = 0;
    for (const m of text.matchAll(/^LF:(\d+)\s*$/gm)) found += Number(m[1]);
    for (const m of text.matchAll(/^LH:(\d+)\s*$/gm)) hit += Number(m[1]);
    return found > 0 ? { format: "lcov", linePercent: round((hit / found) * 100) } : null;
  }
  if (name.endsWith(".json")) {
    try {
      const json = JSON.parse(text) as { total?: { lines?: { pct?: unknown } }; totals?: { percent_covered?: unknown } };
      if (typeof json.total?.lines?.pct === "number") return { format: "Istanbul", linePercent: round(json.total.lines.pct) };
      if (typeof json.totals?.percent_covered === "number") return { format: "coverage.py", linePercent: round(json.totals.percent_covered) };
    } catch {
      return null;
    }
    return null;
  }
  if (name.endsWith(".xml")) {
    const cobertura = /<coverage\b[^>]*\bline-rate="([\d.]+)"/.exec(text);
    if (cobertura) return { format: "Cobertura", linePercent: round(Number(cobertura[1]) * 100) };
    const counters = [...text.matchAll(/<counter\s+type="LINE"\s+missed="(\d+)"\s+covered="(\d+)"\s*\/>/g)];
    const total = counters.at(-1);
    if (total) {
      const missed = Number(total[1]);
      const covered = Number(total[2]);
      return missed + covered > 0 ? { format: "JaCoCo", linePercent: round((covered / (missed + covered)) * 100) } : null;
    }
  }
  return null;
}

export const COVERAGE_REPORT = /(?:^|\/)(?:lcov\.info|coverage-summary\.json|coverage\.json|coverage\.xml|cobertura[\w-]*\.xml|jacoco[\w-]*\.xml)$/i;

export function analyzeTesting(input: TestingInput): { raw: RawPracticeFinding[]; summary: TestingSummary } {
  const raw: RawPracticeFinding[] = [];
  const T = PRACTICE_THRESHOLDS;
  const tests = input.files.filter((f) => f.kind === "TEST");
  const sources = input.files.filter((f) => f.kind === "SOURCE" && f.language);
  const testCodeLines = tests.reduce((n, f) => n + f.codeLines, 0);
  const sourceCodeLines = sources.reduce((n, f) => n + f.codeLines, 0);
  const ratio = sourceCodeLines > 0 ? Math.round((testCodeLines / sourceCodeLines) * 100) / 100 : null;

  // Test cases, focused and skipped tests.
  let testCases = 0;
  let focused = 0;
  let skipped = 0;
  for (const f of input.texts.filter((t) => t.kind === "TEST")) {
    const g = group(f.language);
    if (!g) continue;
    if (TEST_CASE[g]) testCases += (f.text.match(TEST_CASE[g]) ?? []).length;
    f.text.split("\n").forEach((line, i) => {
      if (FOCUSED[g]?.test(line)) {
        focused++;
        if (focused <= 50) {
          raw.push({ rule: "focusedTest", path: f.path, severity: "LOW", line: i + 1, evidence: `\`${snippet(line)}\` runs only this test or suite.`, key: `only:${snippet(line)}` });
        }
      } else if (SKIPPED[g]?.test(line)) {
        skipped++;
        if (skipped <= 50) {
          raw.push({ rule: "skippedTest", path: f.path, severity: "INFO", line: i + 1, evidence: `\`${snippet(line)}\` is skipped.`, key: `skip:${snippet(line)}` });
        }
      }
    });
  }

  // How tests are run.
  const rootPackage = input.texts.find((t) => t.path === "package.json");
  let testScript: string | null = null;
  if (rootPackage) {
    try {
      const scripts = (JSON.parse(rootPackage.text) as { scripts?: Record<string, unknown> }).scripts;
      testScript = typeof scripts?.test === "string" ? scripts.test : null;
    } catch {
      testScript = null;
    }
  }
  const ciFiles = input.texts.filter((t) => CI_FILE.test(t.path));
  const runner = ciFiles.find((f) => TEST_COMMAND.test(f.text));
  const ci = {
    configured: input.ci.length > 0,
    runsTests: !!runner,
    evidence: runner ? `${runner.path}: ${TEST_COMMAND.exec(runner.text)![0]}` : (input.ci[0]?.evidence ?? null),
  };

  // Committed coverage report (the first one that parses).
  let coverage: TestingSummary["coverage"] = null;
  for (const r of input.coverageReports) {
    const parsed = parseCoverage(r.path, r.text);
    if (parsed) {
      coverage = { path: r.path, ...parsed };
      break;
    }
  }

  // Production files that tests refer to by import or by name.
  const referenced = new Set<string>();
  for (const t of tests) {
    referenced.add(testedStem(t.path));
    for (const spec of t.imports) referenced.add(specifierStem(spec));
  }
  const analyzedSources = sources.filter((f) => f.analyzed);
  const isReferenced = (p: string) => referenced.has(sourceStem(p));
  const untested = analyzedSources
    .filter((f) => !isReferenced(f.path) && f.codeLines >= T.untestedFileLoc)
    .sort((a, b) => b.codeLines - a.codeLines || a.path.localeCompare(b.path))
    .slice(0, T.maxUntestedFiles);

  // Findings.
  const enoughCode = sourceCodeLines >= T.noTestsMinLoc;
  if (tests.length === 0 && enoughCode) {
    raw.push({
      rule: "noTests",
      path: "",
      severity: sourceCodeLines >= T.noTestsHighLoc ? "HIGH" : "MEDIUM",
      line: null,
      evidence: `No test files were found for ${sourceCodeLines.toLocaleString("en")} lines of production code in ${sources.length} files.`,
      key: "no-tests",
      data: { sourceCodeLines, sourceFiles: sources.length },
    });
  }
  if (tests.length > 0 && enoughCode && ratio !== null && ratio < T.testRatio.low) {
    raw.push({
      rule: "lowTestRatio",
      path: "",
      severity: ratio < T.testRatio.medium ? "MEDIUM" : "LOW",
      line: null,
      evidence: `${testCodeLines.toLocaleString("en")} lines of test code for ${sourceCodeLines.toLocaleString("en")} lines of production code (ratio ${ratio}; limit ${T.testRatio.low}).`,
      key: "test-ratio",
      data: { value: ratio, limit: T.testRatio.low, testCodeLines, sourceCodeLines },
    });
  }
  if (coverage && coverage.linePercent < T.coverage.low) {
    raw.push({
      rule: "lowCoverage",
      path: coverage.path,
      severity: coverage.linePercent < T.coverage.medium ? "MEDIUM" : "LOW",
      line: null,
      evidence: `The committed ${coverage.format} report \`${coverage.path}\` records ${coverage.linePercent}% line coverage (limit ${T.coverage.low}%).`,
      key: "coverage",
      data: { value: coverage.linePercent, limit: T.coverage.low, format: coverage.format },
    });
  }
  if (tests.length > 0 && !ci.runsTests) {
    raw.push({
      rule: "testsNotInCi",
      path: ciFiles[0]?.path ?? "",
      severity: "LOW",
      line: null,
      evidence: ci.configured
        ? `CI is configured (${input.ci.map((c) => c.evidence).join(", ")}), but no CI file runs a recognised test command.`
        : `${tests.length} test files exist, but no CI configuration (GitHub Actions, GitLab CI, Jenkins, …) was found to run them.`,
      key: "ci",
      data: { ciConfigured: ci.configured },
    });
  }
  const jsSources = sources.some((f) => group(f.language) === "js");
  if (rootPackage && jsSources && tests.length > 0 && (!testScript || DEFAULT_NPM_TEST.test(testScript))) {
    raw.push({
      rule: "noTestScript",
      path: "package.json",
      severity: "LOW",
      line: null,
      evidence: testScript ? `\`scripts.test\` is npm's placeholder: \`${snippet(testScript)}\`.` : "package.json has no `scripts.test`, so `npm test` does not run the tests.",
      key: "test-script",
    });
  }
  if (tests.length > 0) {
    for (const f of untested) {
      raw.push({
        rule: "untestedFile",
        path: f.path,
        severity: "INFO",
        line: null,
        evidence: `${f.codeLines} lines of code; no test imports \`${f.path}\` or is named after it.`,
        key: "untested",
        data: { codeLines: f.codeLines, heuristic: true },
      });
    }
  }

  return {
    raw,
    summary: {
      testFiles: tests.length,
      testCases,
      sourceFiles: sources.length,
      testCodeLines,
      sourceCodeLines,
      testRatio: ratio,
      frameworks: input.frameworks.filter((d) => d.category === "testing").map((d) => ({ name: d.name, evidence: d.evidence })),
      testScript,
      ci,
      coverage,
      focused,
      skipped,
      referencedSourceFiles: analyzedSources.filter((f) => isReferenced(f.path)).length,
      untested: untested.map((f) => ({ path: f.path, codeLines: f.codeLines })),
    },
  };
}
