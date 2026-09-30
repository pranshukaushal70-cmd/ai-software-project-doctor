import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Severity } from "@pd/shared/constants";
import type { ScannedFile } from "../scanner";
import { isAnalyzedLanguage, type AnalyzedLanguage } from "../scanner/languages";
import { ANALYZER_VERSION } from "../version";
import { findDuplicates } from "./duplication";
import { analyzeTree, type FileAnalysis, type FileMetrics, type FunctionMetrics, type RawFinding } from "./file-analyzer";
import { grammarFor, specFor, type GrammarId } from "./languages";
import { parserVersions, parseSource } from "./parser";
import { CODE_THRESHOLDS, RULES } from "./rules";

export const CODE_ANALYZER_ID = "code-metrics";

export interface CodeFinding {
  ruleId: string;
  type: string;
  category: "CODE_QUALITY";
  severity: Severity;
  title: string;
  path: string;
  line: number;
  endLine: number;
  evidence: string;
  impact: string;
  recommendation: string;
  fingerprint: string;
  analyzer: string;
  analyzerVersion: string;
  data: Record<string, unknown> | null;
}

export interface CodeFileResult {
  path: string;
  language: AnalyzedLanguage;
  grammar: GrammarId;
  metrics: FileMetrics & { duplicatedLines: number };
}

export interface SkippedFile {
  path: string;
  reason: "timeout" | "minified" | "read-error" | "oversized";
}

export interface CodeMetricsSummary {
  analyzer: string;
  analyzerVersion: string;
  parser: Record<string, string>;
  thresholds: typeof CODE_THRESHOLDS;
  totals: {
    filesAnalyzed: number;
    sourceFiles: number;
    testFiles: number;
    lines: number;
    codeLines: number;
    commentLines: number;
    blankLines: number;
    logicalLines: number;
    functions: number;
    classes: number;
    imports: number;
    avgComplexity: number;
    maxComplexity: number;
    p90Complexity: number;
    duplicatedLines: number;
    /** Share of production code lines that are part of a clone, 0–100. */
    duplicationPercent: number;
    commentRatio: number;
    filesWithParseErrors: number;
    /** All skipped files; `skipped` lists at most MAX_SKIPPED_LISTED of them. */
    filesSkipped: number;
  };
  byLanguage: Array<{
    language: string;
    files: number;
    codeLines: number;
    commentLines: number;
    functions: number;
    classes: number;
    avgComplexity: number;
    maxComplexity: number;
  }>;
  /** Most complex production functions. */
  hotspots: Array<Pick<FunctionMetrics, "name" | "line" | "endLine" | "complexity" | "codeLines" | "maxNesting" | "parameters"> & { path: string }>;
  largestFiles: Array<{ path: string; codeLines: number; functions: number; maxComplexity: number }>;
  findings: { total: number; stored: number; truncated: boolean; bySeverity: Record<Severity, number>; byType: Record<string, number> };
  duplication: { clones: number; tokensIndexed: number; truncated: boolean };
  skipped: SkippedFile[];
  durationMs: number;
}

export interface CodeAnalysis {
  files: CodeFileResult[];
  findings: CodeFinding[];
  summary: CodeMetricsSummary;
}

export interface AnalyzeCodeOptions {
  /** Abort a single file's parse after this long (pathological input). */
  parseTimeoutMs?: number;
  /** Upper bound on stored findings; the most severe are kept. */
  maxFindings?: number;
  maxDuplicationTokens?: number;
  onProgress?: (done: number, total: number) => void | Promise<void>;
}

const SEVERITY_ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
const MAX_SKIPPED_LISTED = 200;

/** Minified or machine-generated files distort every metric; they are skipped. */
function looksMinified(source: string, lines: number): boolean {
  if (lines === 0) return false;
  const avg = source.length / lines;
  if (avg > 300) return true;
  let longest = 0;
  let start = 0;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source.charCodeAt(i) === 10) {
      longest = Math.max(longest, i - start);
      start = i + 1;
    }
  }
  return longest > 5000;
}

export function fingerprint(ruleId: string, path: string, key: string): string {
  return createHash("sha256").update(`${ruleId}\0${path}\0${key}`).digest("hex");
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

async function analyzeOne(file: ScannedFile, language: AnalyzedLanguage, timeoutMs: number): Promise<{ result: FileAnalysis; grammar: GrammarId } | SkippedFile["reason"]> {
  let source: string;
  try {
    source = await readFile(file.absPath, "utf8");
  } catch {
    return "read-error";
  }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  if (looksMinified(source, file.lines ?? 0)) return "minified";

  let grammar = grammarFor(language, file.path);
  let tree = await parseSource(grammar, source, timeoutMs);
  if (!tree) return "timeout";
  // `.h` headers are shared by C and C++; fall back to the C++ grammar when C cannot parse one.
  if (grammar === "c" && /\.h$/i.test(file.path) && tree.rootNode.hasError) {
    const cpp = await parseSource("cpp", source, timeoutMs);
    if (cpp && !cpp.rootNode.hasError) {
      tree.delete();
      tree = cpp;
      grammar = "cpp";
    } else cpp?.delete();
  }
  try {
    const result = analyzeTree(tree, source, specFor(grammar), {
      path: file.path,
      emitFindings: file.kind === "SOURCE",
      collectTokens: file.kind === "SOURCE",
    });
    return { result, grammar };
  } finally {
    tree.delete();
  }
}

/**
 * Deterministic code metrics and code-quality findings for the analysed
 * languages (JavaScript, TypeScript, Python, Java, C, C++). Metrics are
 * computed for source and test files; findings only for production source.
 */
export async function analyzeCode(files: readonly ScannedFile[], opts: AnalyzeCodeOptions = {}): Promise<CodeAnalysis> {
  const started = performance.now();
  const timeoutMs = opts.parseTimeoutMs ?? 5000;
  const maxFindings = opts.maxFindings ?? 5000;

  const candidates = files.filter(
    (f): f is ScannedFile & { language: AnalyzedLanguage } =>
      isAnalyzedLanguage(f.language) && (f.kind === "SOURCE" || f.kind === "TEST"),
  );

  const results: CodeFileResult[] = [];
  const raw: Array<{ path: string; finding: RawFinding }> = [];
  const tokenInputs: Array<{ path: string; tokens: FileAnalysis["tokens"] }> = [];
  const skipped: SkippedFile[] = [];
  const kinds = new Map<string, ScannedFile["kind"]>();

  for (let i = 0; i < candidates.length; i++) {
    const file = candidates[i]!;
    kinds.set(file.path, file.kind);
    if (file.oversized) {
      skipped.push({ path: file.path, reason: "oversized" });
    } else {
      const outcome = await analyzeOne(file, file.language, timeoutMs);
      if (typeof outcome === "string") skipped.push({ path: file.path, reason: outcome });
      else {
        const { result, grammar } = outcome;
        results.push({ path: file.path, language: file.language, grammar, metrics: { ...result.metrics, duplicatedLines: 0 } });
        for (const finding of result.findings) raw.push({ path: file.path, finding });
        if (result.tokens.hashes.length > 0) tokenInputs.push({ path: file.path, tokens: result.tokens });
      }
    }
    // Yield so the worker's queue lock renewal and other timers keep running.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await opts.onProgress?.(i + 1, candidates.length);
  }

  // ---------------------------------------------------------------- duplication
  const dup = findDuplicates(tokenInputs, {
    minTokens: CODE_THRESHOLDS.duplicateMinTokens,
    minLines: CODE_THRESHOLDS.duplicateMinLines,
    maxTokens: opts.maxDuplicationTokens ?? 2_000_000,
  });
  const byPath = new Map(results.map((r) => [r.path, r]));
  for (const [path, lines] of dup.duplicatedLines) {
    const r = byPath.get(path);
    if (r) r.metrics.duplicatedLines = lines.size;
  }
  for (const clone of dup.clones) {
    const same = clone.original.path === clone.duplicate.path;
    raw.push({
      path: clone.duplicate.path,
      finding: {
        rule: "duplicate",
        severity: clone.lines > CODE_THRESHOLDS.duplicateMediumLines ? "MEDIUM" : "LOW",
        line: clone.duplicate.startLine,
        endLine: clone.duplicate.endLine,
        evidence:
          `Lines ${clone.duplicate.startLine}–${clone.duplicate.endLine} (${clone.tokens} tokens) are identical, ignoring whitespace and comments, ` +
          `to lines ${clone.original.startLine}–${clone.original.endLine} of ${same ? "the same file" : clone.original.path}.`,
        key: `dup:${clone.original.path}:${clone.hash}`,
        data: { original: clone.original, tokens: clone.tokens, lines: clone.lines },
      },
    });
  }

  // ---------------------------------------------------------------- findings
  const ordinals = new Map<string, number>();
  const all: CodeFinding[] = raw.map(({ path, finding }) => {
    const rule = RULES[finding.rule];
    // Several findings can share a key (e.g. two anonymous functions); an ordinal keeps fingerprints unique.
    const base = `${rule.id}\0${path}\0${finding.key}`;
    const ordinal = ordinals.get(base) ?? 0;
    ordinals.set(base, ordinal + 1);
    return {
      ruleId: rule.id,
      type: rule.type,
      category: "CODE_QUALITY",
      severity: finding.severity,
      title: rule.title,
      path,
      line: finding.line,
      endLine: finding.endLine,
      evidence: finding.evidence,
      impact: rule.impact,
      recommendation: rule.recommendation,
      fingerprint: fingerprint(rule.id, path, ordinal === 0 ? finding.key : `${finding.key}#${ordinal}`),
      analyzer: CODE_ANALYZER_ID,
      analyzerVersion: ANALYZER_VERSION,
      data: finding.data ?? null,
    };
  });
  const bySeverity = Object.fromEntries(SEVERITY_ORDER.map((s) => [s, 0])) as Record<Severity, number>;
  const byType: Record<string, number> = {};
  for (const f of all) {
    bySeverity[f.severity]++;
    byType[f.type] = (byType[f.type] ?? 0) + 1;
  }
  const stored = [...all]
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.path.localeCompare(b.path) || a.line - b.line,
    )
    .slice(0, maxFindings);

  // ---------------------------------------------------------------- summary
  const sum = (xs: CodeFileResult[], pick: (m: CodeFileResult["metrics"]) => number) => xs.reduce((n, r) => n + pick(r.metrics), 0);
  const source = results.filter((r) => kinds.get(r.path) === "SOURCE");
  const allFunctions = results.flatMap((r) => r.metrics.functions);
  const complexities = allFunctions.map((f) => f.complexity).sort((a, b) => a - b);
  const sourceCode = sum(source, (m) => m.codeLines);
  const duplicatedLines = sum(source, (m) => m.duplicatedLines);
  const codeLines = sum(results, (m) => m.codeLines);
  const commentLines = sum(results, (m) => m.commentLines);

  const langMap = new Map<string, CodeFileResult[]>();
  for (const r of results) langMap.set(r.language, [...(langMap.get(r.language) ?? []), r]);
  const byLanguage = [...langMap.entries()]
    .map(([language, rs]) => {
      const fns = rs.flatMap((r) => r.metrics.functions);
      return {
        language,
        files: rs.length,
        codeLines: sum(rs, (m) => m.codeLines),
        commentLines: sum(rs, (m) => m.commentLines),
        functions: fns.length,
        classes: sum(rs, (m) => m.classCount),
        avgComplexity: fns.length ? round2(fns.reduce((n, f) => n + f.complexity, 0) / fns.length) : 0,
        maxComplexity: fns.reduce((m, f) => Math.max(m, f.complexity), 0),
      };
    })
    .sort((a, b) => b.codeLines - a.codeLines);

  const hotspots = source
    .flatMap((r) => r.metrics.functions.map((f) => ({ path: r.path, ...f })))
    .sort((a, b) => b.complexity - a.complexity || b.codeLines - a.codeLines)
    .slice(0, 20)
    .map(({ path, name, line, endLine, complexity, codeLines, maxNesting, parameters }) => ({
      path,
      name,
      line,
      endLine,
      complexity,
      codeLines,
      maxNesting,
      parameters,
    }));

  const largestFiles = [...source]
    .sort((a, b) => b.metrics.codeLines - a.metrics.codeLines)
    .slice(0, 10)
    .map((r) => ({ path: r.path, codeLines: r.metrics.codeLines, functions: r.metrics.functionCount, maxComplexity: r.metrics.maxComplexity }));

  const summary: CodeMetricsSummary = {
    analyzer: CODE_ANALYZER_ID,
    analyzerVersion: ANALYZER_VERSION,
    parser: parserVersions(),
    thresholds: CODE_THRESHOLDS,
    totals: {
      filesAnalyzed: results.length,
      sourceFiles: source.length,
      testFiles: results.length - source.length,
      lines: sum(results, (m) => m.lines),
      codeLines,
      commentLines,
      blankLines: sum(results, (m) => m.blankLines),
      logicalLines: sum(results, (m) => m.logicalLines),
      functions: allFunctions.length,
      classes: sum(results, (m) => m.classCount),
      imports: sum(results, (m) => m.imports.length),
      avgComplexity: complexities.length ? round2(complexities.reduce((a, b) => a + b, 0) / complexities.length) : 0,
      maxComplexity: complexities.at(-1) ?? 0,
      p90Complexity: percentile(complexities, 90),
      duplicatedLines,
      duplicationPercent: sourceCode ? round2((duplicatedLines / sourceCode) * 100) : 0,
      commentRatio: codeLines + commentLines ? round2(commentLines / (codeLines + commentLines)) : 0,
      filesWithParseErrors: results.filter((r) => r.metrics.parseErrors > 0).length,
      filesSkipped: skipped.length,
    },
    byLanguage,
    hotspots,
    largestFiles,
    findings: { total: all.length, stored: stored.length, truncated: all.length > stored.length, bySeverity, byType },
    duplication: { clones: dup.clones.length, tokensIndexed: dup.tokensIndexed, truncated: dup.truncated },
    skipped: skipped.slice(0, MAX_SKIPPED_LISTED),
    durationMs: Math.round(performance.now() - started),
  };

  return { files: results, findings: stored, summary };
}

export { CODE_THRESHOLDS, RULES } from "./rules";
export { redactSecrets } from "./evidence";
export type { FileMetrics, FunctionMetrics, ClassMetrics } from "./file-analyzer";
