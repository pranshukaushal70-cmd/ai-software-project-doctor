import type { RepositoryScan } from "@pd/analyzer";
import type { ArchitectureAnalysis, ArchitectureEdgeRecord, ArchitectureFinding, ArchitectureNodeRecord } from "@pd/analyzer/architecture";
import type { AnalyzedDependency, DependencyAnalysis, DependencyFinding } from "@pd/analyzer/dependencies";
import type { CodeAnalysis, CodeFinding } from "@pd/analyzer/metrics";
import type { SecurityAnalysis, SecurityFinding } from "@pd/analyzer/security";
import type { Prisma } from "@pd/db";

export type AnyFinding = CodeFinding | SecurityFinding | DependencyFinding | ArchitectureFinding;

/** File rows: scanner inventory merged with code metrics where the file was analysed. */
export function buildFileRows(analysisId: string, scan: RepositoryScan, code: CodeAnalysis): Prisma.FileCreateManyInput[] {
  const metrics = new Map(code.files.map((f) => [f.path, f.metrics]));
  return scan.files.map((f) => {
    const m = metrics.get(f.path);
    return {
      analysisId,
      path: f.path,
      language: f.language,
      kind: f.kind,
      size: f.size,
      lines: f.lines,
      ...(m && {
        loc: m.codeLines,
        lloc: m.logicalLines,
        commentLines: m.commentLines,
        blankLines: m.blankLines,
        functionCount: m.functionCount,
        classCount: m.classCount,
        maxComplexity: m.maxComplexity,
        avgComplexity: m.avgComplexity,
        maxNesting: m.maxNesting,
        duplicatedLines: m.duplicatedLines,
        parseErrors: m.parseErrors,
        imports: m.imports,
        exports: m.exports,
      }),
    };
  });
}

export function buildFindingRows(
  analysisId: string,
  findings: ReadonlyArray<AnyFinding>,
  fileIds: ReadonlyMap<string, string>,
): Prisma.FindingCreateManyInput[] {
  return findings.map((f) => ({
    analysisId,
    fileId: fileIds.get(f.path) ?? null,
    category: f.category,
    type: f.type,
    severity: f.severity,
    ruleId: f.ruleId,
    title: f.title,
    line: f.line,
    endLine: f.endLine,
    evidence: f.evidence,
    impact: f.impact,
    recommendation: f.recommendation,
    fingerprint: f.fingerprint,
    data: (f.data ?? undefined) as Prisma.InputJsonValue | undefined,
    analyzer: f.analyzer,
    analyzerVersion: f.analyzerVersion,
  }));
}

/** Repository-level metrics (fileId = null), queryable across analyses for trends and scoring. */
export function buildRepositoryMetricRows(analysisId: string, code: CodeAnalysis): Prisma.MetricCreateManyInput[] {
  const t = code.summary.totals;
  const values: Record<string, number> = {
    "code.files": t.filesAnalyzed,
    "code.lines": t.lines,
    "code.loc": t.codeLines,
    "code.lloc": t.logicalLines,
    "code.comment_lines": t.commentLines,
    "code.blank_lines": t.blankLines,
    "code.comment_ratio": t.commentRatio,
    "code.functions": t.functions,
    "code.classes": t.classes,
    "code.imports": t.imports,
    "complexity.avg": t.avgComplexity,
    "complexity.p90": t.p90Complexity,
    "complexity.max": t.maxComplexity,
    "duplication.lines": t.duplicatedLines,
    "duplication.percent": t.duplicationPercent,
    "findings.code_quality": code.summary.findings.total,
  };
  for (const [severity, n] of Object.entries(code.summary.findings.bySeverity)) {
    values[`findings.code_quality.${severity.toLowerCase()}`] = n;
  }
  return Object.entries(values).map(([key, value]) => ({ analysisId, key, value }));
}

/** Repository-level security metrics, stored alongside the code metrics for trends and scoring. */
export function buildSecurityMetricRows(analysisId: string, sec: SecurityAnalysis): Prisma.MetricCreateManyInput[] {
  const t = sec.summary.totals;
  const values: Record<string, number> = {
    "security.findings": t.findings,
    "security.secrets": t.secrets,
    "security.insecure_patterns": t.insecurePatterns,
    "security.files_with_findings": t.filesWithFindings,
    "security.files_scanned": t.filesScanned,
  };
  for (const [severity, n] of Object.entries(t.bySeverity)) values[`security.findings.${severity.toLowerCase()}`] = n;
  return Object.entries(values).map(([key, value]) => ({ analysisId, key, value }));
}

/** Dependency rows: one per declared or locked package, with the advisories affecting its resolved version. */
export function buildDependencyRows(analysisId: string, dependencies: readonly AnalyzedDependency[]): Prisma.DependencyCreateManyInput[] {
  return dependencies.map((d) => ({
    analysisId,
    ecosystem: d.ecosystem,
    name: d.name,
    versionSpec: d.versionSpec,
    resolvedVersion: d.resolvedVersion,
    direct: d.direct,
    dev: d.dev,
    manifestPath: d.manifestPath,
    vulnIds: d.vulnIds,
    dataSource: d.dataSource,
    unusedCandidate: d.unusedCandidate,
  }));
}

export function buildArchitectureNodeRows(analysisId: string, nodes: readonly ArchitectureNodeRecord[]): Prisma.ArchitectureNodeCreateManyInput[] {
  return nodes.map((n) => ({
    analysisId,
    key: n.key,
    kind: n.kind,
    label: n.label,
    layer: n.layer,
    metrics: n.metrics as Prisma.InputJsonObject,
  }));
}

/** Edge rows reference node ids, which exist only after the nodes are inserted (`nodeIds`: node key → id). */
export function buildArchitectureEdgeRows(
  analysisId: string,
  edges: readonly ArchitectureEdgeRecord[],
  nodeIds: ReadonlyMap<string, string>,
): Prisma.ArchitectureEdgeCreateManyInput[] {
  const rows: Prisma.ArchitectureEdgeCreateManyInput[] = [];
  for (const e of edges) {
    const fromId = nodeIds.get(e.from);
    const toId = nodeIds.get(e.to);
    if (!fromId || !toId) continue;
    rows.push({ analysisId, fromId, toId, kind: e.kind, weight: e.weight, inCycle: e.inCycle });
  }
  return rows;
}

/** Repository-level dependency metrics, stored for trends and scoring. */
export function buildDependencyMetricRows(analysisId: string, dep: DependencyAnalysis): Prisma.MetricCreateManyInput[] {
  const t = dep.summary.totals;
  const values: Record<string, number> = {
    "dependencies.total": t.dependencies,
    "dependencies.direct": t.direct,
    "dependencies.transitive": t.transitive,
    "dependencies.dev": t.dev,
    "dependencies.resolved": t.resolved,
    "dependencies.vulnerable": t.vulnerable,
    "dependencies.vulnerable_direct": t.vulnerableDirect,
    "dependencies.advisories": t.advisories,
    "dependencies.unpinned": t.unpinned,
    "dependencies.non_registry": t.nonRegistry,
    "dependencies.unused_candidates": t.unusedCandidates,
    "dependencies.vulnerability_scan_checked": dep.summary.vulnerabilityScan.queried,
    "findings.dependency": dep.summary.findings.total,
  };
  for (const [severity, n] of Object.entries(t.bySeverity)) values[`dependencies.vulnerable.${severity.toLowerCase()}`] = n;
  return Object.entries(values).map(([key, value]) => ({ analysisId, key, value }));
}

/** Repository-level architecture metrics, stored for trends and scoring. */
export function buildArchitectureMetricRows(analysisId: string, arch: ArchitectureAnalysis): Prisma.MetricCreateManyInput[] {
  const t = arch.summary.totals;
  const values: Record<string, number> = {
    "architecture.files": t.files,
    "architecture.edges": t.edges,
    "architecture.cycles": t.cycles,
    "architecture.files_in_cycles": t.filesInCycles,
    "architecture.modules": t.modules,
    "architecture.module_edges": t.moduleEdges,
    "architecture.layer_violations": t.layerViolations,
    "architecture.isolated_files": t.isolatedFiles,
    "architecture.max_fan_in": t.maxFanIn,
    "architecture.max_fan_out": t.maxFanOut,
    "architecture.avg_fan_out": t.avgFanOut,
    "architecture.unresolved_imports": t.unresolvedImports,
    "findings.architecture": arch.summary.findings.total,
  };
  return Object.entries(values).map(([key, value]) => ({ analysisId, key, value }));
}
