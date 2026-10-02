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
  /** Present from analyzer v0.3.0 on. */
  security?: SecuritySummaryDto;
  /** Present from analyzer v0.4.0 on. */
  dependencies?: DependencySummaryDto;
  /** Present from analyzer v0.4.0 on. */
  architecture?: ArchitectureSummaryDto;
}

/** Shape of summary.security (packages/analyzer/src/security/index.ts SecuritySummary). */
export interface SecuritySummaryDto {
  analyzer: string;
  analyzerVersion: string;
  totals: {
    findings: number;
    secrets: number;
    insecurePatterns: number;
    filesScanned: number;
    sourceFilesInspected: number;
    filesWithFindings: number;
    bySeverity: Record<SeverityDto, number>;
    /** Present from analyzer v0.4.1 on. */
    secretsByContext?: Record<"source" | "configuration" | "template" | "test" | "documentation", number>;
  };
  rules: Array<{
    id: string;
    type: string;
    category: "SECRET" | "SECURITY";
    title: string;
    cwe: string;
    owasp: string;
    count: number;
    maxSeverity: SeverityDto;
  }>;
  topFiles: Array<{ path: string; findings: number; maxSeverity: SeverityDto }>;
  envFiles: string[];
  findings: { total: number; stored: number; truncated: boolean };
  errors: number;
  durationMs: number;
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
  /** The repository owner's decision about this finding, matched by fingerprint. */
  triage?: TriageDto | null;
}

export interface TriageDto {
  status: "EXPECTED" | "IGNORED";
  reason: string | null;
  updatedAt: string;
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

export type EcosystemDto = "npm" | "PyPI" | "Maven" | "Go" | "crates.io";

export interface AdvisoryDto {
  id: string;
  aliases: string[];
  summary: string;
  severity: SeverityDto;
  score: number | null;
  url: string;
}

/** Shape of summary.dependencies (packages/analyzer/src/dependencies/index.ts DependencySummary). */
export interface DependencySummaryDto {
  analyzer: string;
  analyzerVersion: string;
  manifests: Array<{ path: string; ecosystem: EcosystemDto; kind: "manifest" | "lockfile"; dependencies: number }>;
  totals: {
    dependencies: number;
    direct: number;
    transitive: number;
    dev: number;
    resolved: number;
    vulnerable: number;
    vulnerableDirect: number;
    advisories: number;
    bySeverity: Record<SeverityDto, number>;
    unpinned: number;
    nonRegistry: number;
    unusedCandidates: number;
  };
  byEcosystem: Array<{ ecosystem: EcosystemDto; dependencies: number; direct: number; vulnerable: number }>;
  vulnerabilityScan: {
    status: "completed" | "partial" | "failed" | "disabled" | "skipped";
    source: string;
    queried: number;
    notChecked: number;
    error: string | null;
    durationMs: number;
  };
  vulnerable: Array<{
    ecosystem: EcosystemDto;
    name: string;
    version: string;
    direct: boolean;
    dev: boolean;
    manifestPath: string;
    severity: SeverityDto;
    fixedVersion: string | null;
    advisories: AdvisoryDto[];
  }>;
  unusedCandidates: Array<{ name: string; manifestPath: string }>;
  dependencies: { total: number; stored: number; truncated: boolean };
  findings: { total: number; stored: number; truncated: boolean; bySeverity: Record<SeverityDto, number>; byType: Record<string, number> };
  errors: number;
  durationMs: number;
}

/** One row of GET /api/analysis/:id/dependencies. */
export interface DependencyDto {
  id: string;
  ecosystem: EcosystemDto;
  name: string;
  versionSpec: string | null;
  resolvedVersion: string | null;
  direct: boolean;
  dev: boolean;
  manifestPath: string;
  vulnIds: string[];
  dataSource: string | null;
  unusedCandidate: boolean;
  /** Advisory details; present for the most severe vulnerable packages only. */
  vulnerability: { severity: SeverityDto; fixedVersion: string | null; advisories: AdvisoryDto[] } | null;
}

export interface DependenciesPageDto {
  summary: DependencySummaryDto | null;
  dependencies: DependencyDto[];
  page: number;
  pageSize: number;
  total: number;
  facets: { ecosystem: Array<{ value: EcosystemDto; count: number }> };
}

export type LayerIdDto = "interface" | "service" | "data" | "shared";

/** Shape of summary.architecture (packages/analyzer/src/architecture/index.ts ArchitectureSummary). */
export interface ArchitectureSummaryDto {
  analyzer: string;
  analyzerVersion: string;
  thresholds: { fanOut: { low: number; medium: number }; largeCycleFiles: number; maxModules: number };
  totals: {
    files: number;
    edges: number;
    internalImports: number;
    externalImports: number;
    builtinImports: number;
    unresolvedImports: number;
    cycles: number;
    filesInCycles: number;
    modules: number;
    moduleEdges: number;
    layerViolations: number;
    isolatedFiles: number;
    maxFanIn: number;
    maxFanOut: number;
    avgFanOut: number;
  };
  byLanguage: Array<{ language: string; files: number; edges: number; unresolved: number }>;
  moduleDepth: number;
  modules: Array<{
    key: string;
    label: string;
    files: number;
    loc: number;
    fanIn: number;
    fanOut: number;
    instability: number;
    layer: LayerIdDto | null;
    inCycle: boolean;
  }>;
  moduleEdges: Array<{ from: string; to: string; weight: number; inCycle: boolean }>;
  cycles: Array<{ files: string[]; size: number; path: string[]; severity: SeverityDto }>;
  hubs: Array<{ path: string; fanIn: number; fanOut: number }>;
  mostDependent: Array<{ path: string; fanIn: number; fanOut: number }>;
  layers: { applied: boolean; order: Array<{ id: LayerIdDto; label: string; files: number }>; violations: number };
  topExternal: Array<{ name: string; language: string; files: number }>;
  resolution: { tsconfigs: number; pathAliases: number; workspacePackages: number; pythonRoots: string[] };
  nodes: { total: number; stored: number; truncated: boolean };
  findings: { total: number; stored: number; truncated: boolean; bySeverity: Record<SeverityDto, number>; byType: Record<string, number> };
  durationMs: number;
}

export interface GraphNodeDto {
  key: string;
  kind: "FILE" | "MODULE";
  label: string;
  layer: string | null;
  metrics: Record<string, unknown> | null;
}

export interface GraphEdgeDto {
  from: string;
  to: string;
  kind: string;
  weight: number;
  inCycle: boolean;
}

/** GET /api/analysis/:id/architecture. */
export interface ArchitectureGraphDto {
  summary: ArchitectureSummaryDto | null;
  view: "modules" | "files";
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  total: number;
  truncated: boolean;
}
