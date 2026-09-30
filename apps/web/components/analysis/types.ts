export interface Detection {
  name: string;
  category: string;
  evidence: string;
}

/** Shape of Analysis.summary as written by the worker (apps/worker/src/summary.ts). */
export interface ScanSummaryDto {
  modulesRun: string[];
  ingest: { source: string; commitSha?: string; extractedFiles?: number; skippedEntries?: number; oversizedEntries?: number };
  totals: { files: number; bytes: number; lines: number; byKind: Record<string, number> };
  languages: Array<{ language: string; files: number; lines: number; bytes: number; analyzed: boolean }>;
  primaryLanguage: string | null;
  packageManagers: Detection[];
  buildSystems: Detection[];
  frameworks: Detection[];
  ci: Detection[];
  containers: Detection[];
  envFiles: Array<{ path: string; isTemplate: boolean }>;
  entryPoints: Detection[];
  docs: { readme: string | null; license: string | null; contributing: string | null; changelog: string | null; docsDir: boolean };
  ignored: { dirs: string[]; dirsTruncated: boolean; gitignoredFiles: number; symlinksSkipped: number; truncated: boolean };
  oversizedFiles: string[];
  /** Present from analyzer v0.2.0 on. */
  codeMetrics?: CodeMetricsDto;
}

export type SeverityDto = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

/** Shape of summary.codeMetrics (packages/analyzer/src/metrics/index.ts CodeMetricsSummary). */
export interface CodeMetricsDto {
  analyzer: string;
  analyzerVersion: string;
  parser: Record<string, string>;
  thresholds: {
    complexity: { medium: number; high: number };
    nesting: { medium: number; high: number };
    functionCodeLines: { medium: number; high: number };
    parameters: { low: number; medium: number };
    fileCodeLines: { low: number; medium: number; high: number };
    classMethods: number;
    classCodeLines: number;
    duplicateMinTokens: number;
    duplicateMinLines: number;
  };
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
    duplicationPercent: number;
    commentRatio: number;
    filesWithParseErrors: number;
    /** Present from analyzer v0.2.1 on; `skipped` below lists at most 200 files. */
    filesSkipped?: number;
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
  hotspots: Array<{
    path: string;
    name: string;
    line: number;
    endLine: number;
    complexity: number;
    codeLines: number;
    maxNesting: number;
    parameters: number;
  }>;
  largestFiles: Array<{ path: string; codeLines: number; functions: number; maxComplexity: number }>;
  findings: { total: number; stored: number; truncated: boolean; bySeverity: Record<SeverityDto, number>; byType: Record<string, number> };
  duplication: { clones: number; tokensIndexed: number; truncated: boolean };
  skipped: Array<{ path: string; reason: string }>;
  durationMs: number;
}

export interface FindingDto {
  id: string;
  category: string;
  type: string;
  severity: SeverityDto;
  ruleId: string;
  title: string;
  path: string | null;
  language: string | null;
  line: number | null;
  endLine: number | null;
  evidence: string | null;
  impact: string | null;
  recommendation: string | null;
  fingerprint: string;
  data: Record<string, unknown> | null;
  analyzer: string;
  analyzerVersion: string;
}

export interface FindingsPageDto {
  findings: FindingDto[];
  page: number;
  pageSize: number;
  total: number;
  facets: { severity: Array<{ value: SeverityDto; count: number }>; type: Array<{ value: string; count: number }> };
}

export interface FileMetricsDto {
  id: string;
  path: string;
  language: string | null;
  kind: string;
  size: number;
  lines: number | null;
  loc: number | null;
  lloc: number | null;
  commentLines: number | null;
  blankLines: number | null;
  functionCount: number | null;
  classCount: number | null;
  maxComplexity: number | null;
  avgComplexity: number | null;
  maxNesting: number | null;
  duplicatedLines: number | null;
  parseErrors: number | null;
  _count: { findings: number };
}

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  fileCount: number;
  children?: TreeNode[];
}
