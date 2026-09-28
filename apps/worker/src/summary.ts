import type { RepositoryScan } from "@pd/analyzer";
import type { CodeMetricsSummary } from "@pd/analyzer/metrics";

export interface IngestInfo {
  source: string;
  commitSha?: string;
  extractedFiles?: number;
  skippedEntries?: number;
  oversizedEntries?: number;
}

/** Analysis modules that exist in this analyzer version; the UI lists only what actually ran. */
export const MODULES_RUN = ["repository-scan", "code-metrics"] as const;

const MAX_IGNORED_DIRS = 200;

/**
 * JSON-safe summary persisted on the Analysis row. Excludes per-file data
 * (stored as File rows) and absolute paths (they reveal worker filesystem layout).
 */
export function summarizeScan(scan: RepositoryScan, ingest: IngestInfo, codeMetrics: CodeMetricsSummary) {
  return {
    modulesRun: [...MODULES_RUN],
    ingest,
    totals: scan.totals,
    languages: scan.languages,
    primaryLanguage: scan.primaryLanguage,
    packageManagers: scan.packageManagers,
    buildSystems: scan.buildSystems,
    frameworks: scan.frameworks,
    ci: scan.ci,
    containers: scan.containers,
    envFiles: scan.envFiles,
    entryPoints: scan.entryPoints,
    docs: scan.docs,
    ignored: {
      ...scan.ignored,
      dirs: scan.ignored.dirs.slice(0, MAX_IGNORED_DIRS),
      dirsTruncated: scan.ignored.dirs.length > MAX_IGNORED_DIRS,
    },
    oversizedFiles: scan.files.filter((f) => f.oversized).map((f) => f.path),
    codeMetrics,
  };
}

export type ScanSummary = ReturnType<typeof summarizeScan>;
