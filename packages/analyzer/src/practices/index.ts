import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { SEVERITIES, type Severity } from "@pd/shared/constants";
import { fingerprint, type CodeAnalysis } from "../metrics";
import type { RepositoryScan, ScannedFile } from "../scanner";
import { isAnalyzedLanguage } from "../scanner/languages";
import { severityRank } from "../security/types";
import { ANALYZER_VERSION } from "../version";
import { analyzeApi, type ApiSummary } from "./api";
import { analyzeDatabase, type DatabaseSummary } from "./database";
import { analyzeDocumentation, type DocumentationSummary } from "./docs";
import { PRACTICE_RULES, PRACTICE_THRESHOLDS, type PracticeCategory } from "./rules";
import { analyzeTesting, COVERAGE_REPORT, type TestingSummary } from "./testing";
import type { PracticeFinding, RawPracticeFinding, TextFile } from "./types";

export const PRACTICES_ANALYZER_ID = "practices";

export interface PracticesSummary {
  analyzer: string;
  analyzerVersion: string;
  thresholds: typeof PRACTICE_THRESHOLDS;
  api: ApiSummary;
  database: DatabaseSummary;
  testing: TestingSummary;
  documentation: DocumentationSummary;
  findings: {
    total: number;
    stored: number;
    truncated: boolean;
    bySeverity: Record<Severity, number>;
    byCategory: Record<PracticeCategory, number>;
    byType: Record<string, number>;
  };
  /** Files that could not be read; analysis continued without them. */
  errors: number;
  durationMs: number;
}

export interface PracticesAnalysis {
  findings: PracticeFinding[];
  summary: PracticesSummary;
}

export interface AnalyzePracticesOptions {
  /** Repository root on disk; enables reading committed coverage reports in `coverage/`, which the scanner skips. */
  root?: string;
  maxFindings?: number;
}

const MANIFEST = /^(?:package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|pom\.xml|build\.gradle(?:\.kts)?)$/;
/** Coverage reports can be large; they are read up to this size even when other files of that size are skipped. */
const MAX_COVERAGE_BYTES = 20 * 1024 * 1024;
const COVERAGE_DIR_REPORTS = ["coverage-summary.json", "lcov.info", "cobertura-coverage.xml", "coverage.xml"];

const wanted = (f: ScannedFile) =>
  f.kind === "SOURCE" ||
  f.kind === "TEST" ||
  f.kind === "DOCUMENTATION" ||
  f.kind === "CONFIG" ||
  /\.(?:sql|prisma)$/i.test(f.path);

/**
 * Committed coverage reports under `<root>/coverage/`. Both the directory and the
 * file must be real (not symlinks), so a crafted repository cannot point the
 * read outside its own tree.
 */
async function readCoverageDir(root: string): Promise<TextFile[]> {
  const dir = path.join(root, "coverage");
  const stat = await lstat(dir).catch(() => null);
  if (!stat?.isDirectory()) return [];
  const out: TextFile[] = [];
  for (const name of COVERAGE_DIR_REPORTS) {
    const file = path.join(dir, name);
    const s = await lstat(file).catch(() => null);
    if (!s?.isFile() || s.size > MAX_COVERAGE_BYTES) continue;
    const text = await readFile(file, "utf8").catch(() => null);
    if (text !== null) out.push({ path: `coverage/${name}`, language: null, kind: "OTHER", text });
  }
  return out;
}

/**
 * Runs the API, database, testing and documentation analyzers over one read of
 * the relevant files and returns their findings (most severe first, capped) and
 * summaries.
 */
export async function analyzePractices(scan: RepositoryScan, code: CodeAnalysis, opts: AnalyzePracticesOptions = {}): Promise<PracticesAnalysis> {
  const started = performance.now();
  let errors = 0;
  const read = async (f: ScannedFile, limit?: number): Promise<TextFile | null> => {
    if (f.kind === "BINARY" || (limit === undefined ? f.oversized : f.size > limit)) return null;
    try {
      return { path: f.path, language: f.language, kind: f.kind, text: await readFile(f.absPath, "utf8") };
    } catch {
      errors++;
      return null;
    }
  };

  // Sequential reads, like the secret scanner: a large repository must not exhaust file descriptors.
  const texts: TextFile[] = [];
  for (const f of scan.files) {
    if (!wanted(f)) continue;
    const t = await read(f);
    if (t) texts.push(t);
  }
  const coverageReports: TextFile[] = [];
  for (const f of scan.files) {
    if (!COVERAGE_REPORT.test(f.path)) continue;
    const t = await read(f, MAX_COVERAGE_BYTES);
    if (t) coverageReports.push(t);
  }
  if (opts.root) coverageReports.push(...(await readCoverageDir(opts.root)));
  const allPaths = scan.files.map((f) => f.path);
  const manifests = texts.filter((t) => MANIFEST.test(t.path.split("/").pop()!));

  const metrics = new Map(code.files.map((f) => [f.path, f.metrics]));
  const testingFiles = scan.files
    .filter((f) => f.kind === "SOURCE" || f.kind === "TEST")
    .map((f) => {
      const m = metrics.get(f.path);
      return { path: f.path, kind: f.kind, language: f.language, codeLines: m?.codeLines ?? f.lines ?? 0, imports: m?.imports ?? [], analyzed: isAnalyzedLanguage(f.language) && !!m };
    });

  const api = analyzeApi(texts, allPaths, manifests);
  const database = analyzeDatabase(texts, allPaths, scan.frameworks);
  const testing = analyzeTesting({ files: testingFiles, texts, coverageReports, frameworks: scan.frameworks, ci: scan.ci });
  const documentation = analyzeDocumentation({ texts, allPaths, docs: scan.docs, envFiles: scan.envFiles });

  const raw: RawPracticeFinding[] = [...api.raw, ...database.raw, ...testing.raw, ...documentation.raw];
  const ordinals = new Map<string, number>();
  const all: PracticeFinding[] = raw.map((f) => {
    const rule = PRACTICE_RULES[f.rule];
    const base = `${rule.id}\0${f.path}\0${f.key}`;
    const ordinal = ordinals.get(base) ?? 0;
    ordinals.set(base, ordinal + 1);
    return {
      ruleId: rule.id,
      type: rule.type,
      category: rule.category,
      severity: f.severity,
      title: rule.title,
      path: f.path,
      line: f.line,
      endLine: f.line,
      evidence: f.evidence,
      impact: rule.impact,
      recommendation: rule.recommendation,
      fingerprint: fingerprint(rule.id, f.path, ordinal === 0 ? f.key : `${f.key}#${ordinal}`),
      analyzer: PRACTICES_ANALYZER_ID,
      analyzerVersion: ANALYZER_VERSION,
      data: { ...(rule.cwe && { cwe: rule.cwe }), ...f.data },
    };
  });

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byCategory: Record<PracticeCategory, number> = { API: 0, DATABASE: 0, TESTING: 0, DOCUMENTATION: 0 };
  const byType: Record<string, number> = {};
  for (const f of all) {
    bySeverity[f.severity]++;
    byCategory[f.category]++;
    byType[f.type] = (byType[f.type] ?? 0) + 1;
  }
  const maxFindings = opts.maxFindings ?? 2000;
  const stored = [...all]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0))
    .slice(0, maxFindings);

  return {
    findings: stored,
    summary: {
      analyzer: PRACTICES_ANALYZER_ID,
      analyzerVersion: ANALYZER_VERSION,
      thresholds: PRACTICE_THRESHOLDS,
      api: api.summary,
      database: database.summary,
      testing: testing.summary,
      documentation: documentation.summary,
      findings: { total: all.length, stored: stored.length, truncated: all.length > stored.length, bySeverity, byCategory, byType },
      errors,
      durationMs: Math.round(performance.now() - started),
    },
  };
}

export { PRACTICE_RULES, PRACTICE_THRESHOLDS, type PracticeCategory } from "./rules";
export { parseCoverage } from "./testing";
export type { PracticeFinding } from "./types";
export type { ApiEndpoint, ApiSummary } from "./api";
export type { DatabaseSummary } from "./database";
export type { TestingSummary } from "./testing";
export type { DocumentationSummary, ReadmeSection } from "./docs";
