import type { RepositoryScan } from "@pd/analyzer";
import type { CodeAnalysis, CodeFinding } from "@pd/analyzer/metrics";
import type { SecurityAnalysis, SecurityFinding } from "@pd/analyzer/security";
import type { Prisma } from "@pd/db";

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
  findings: ReadonlyArray<CodeFinding | SecurityFinding>,
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
