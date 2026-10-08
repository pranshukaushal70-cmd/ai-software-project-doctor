import type { Logger } from "@pd/shared/logger";
import { analyzeArchitecture, type ArchitectureAnalysis } from "./architecture";
import { analyzeDependencies, type DependencyAnalysis } from "./dependencies";
import { buildRepositoryIndex, createSymbolCollector, type RepositoryIndex } from "./intelligence";
import { analyzeCode, type CodeAnalysis } from "./metrics";
import { analyzePractices, type PracticesAnalysis } from "./practices";
import { scanRepository, type RepositoryScan } from "./scanner";
import { computeHealthScore, type HealthScore } from "./scoring";
import { createSecurityScanner } from "./security";

/**
 * Every deterministic analysis module, in pipeline order, over one directory. The
 * worker's analysis pipeline persists the result; the evaluation benchmark (Phase 10)
 * measures it. Sharing this one function keeps what is benchmarked identical to what
 * users get. No database, no repository code is executed; the only network access is
 * the optional OSV.dev lookup, through the `fetch` the caller passes in.
 */

export type AnalyzerStage = "SCANNING" | "PARSING" | "SECURITY" | "DEPENDENCIES" | "ARCHITECTURE" | "PRACTICES" | "INDEXING";

export interface RunAnalyzersOptions {
  /** Repository name stored in the index. */
  name: string;
  maxFileBytes: number;
  /** OSV.dev lookup of exact dependency versions; omitted = no network access. */
  osv?: { fetch: typeof fetch; budgetMs: number };
  /** Fingerprints of findings the user triaged as Expected/Ignored; they do not lower the health score. */
  excludedFingerprints?: () => Promise<ReadonlySet<string>>;
  /** Called before each stage starts. */
  onStage?: (stage: AnalyzerStage) => Promise<unknown>;
  /** Parsing progress (files done of total). */
  onParseProgress?: (done: number, total: number) => Promise<void>;
  log: Pick<Logger, "info" | "warn">;
}

export type AnalyzerFinding =
  | CodeAnalysis["findings"][number]
  | Awaited<ReturnType<ReturnType<typeof createSecurityScanner>["finish"]>>["findings"][number]
  | DependencyAnalysis["findings"][number]
  | ArchitectureAnalysis["findings"][number]
  | PracticesAnalysis["findings"][number];

export interface AnalyzerResults {
  scan: RepositoryScan;
  code: CodeAnalysis;
  security: Awaited<ReturnType<ReturnType<typeof createSecurityScanner>["finish"]>>;
  dependencies: DependencyAnalysis;
  architecture: ArchitectureAnalysis;
  practices: PracticesAnalysis;
  /** Every module's findings, in module order. */
  findings: AnalyzerFinding[];
  health: HealthScore;
  index: RepositoryIndex;
}

export async function runAnalyzers(root: string, opts: RunAnalyzersOptions): Promise<AnalyzerResults> {
  const { log } = opts;
  const stage = async (s: AnalyzerStage) => {
    await opts.onStage?.(s);
  };
  const started = Date.now();

  await stage("SCANNING");
  const scan = await scanRepository(root, { maxFileBytes: opts.maxFileBytes });
  log.info({ files: scan.totals.files, ms: Date.now() - started }, "scan complete");

  await stage("PARSING");
  // Insecure-pattern rules and symbol extraction run on the same syntax trees as the metrics (one parse per file).
  const security = createSecurityScanner();
  const symbolCollector = createSymbolCollector();
  const code = await analyzeCode(scan.files, {
    onTree: (ctx) => {
      security.inspectTree(ctx);
      // A symbol-extraction failure must not cost the file its security inspection, and vice versa.
      try {
        symbolCollector.inspectTree(ctx);
      } catch (err) {
        log.warn({ err, path: ctx.path }, "symbol extraction failed");
      }
    },
    onProgress: opts.onParseProgress,
  });
  log.info(
    { files: code.summary.totals.filesAnalyzed, findings: code.summary.findings.total, ms: code.summary.durationMs },
    "code metrics complete",
  );

  await stage("SECURITY");
  const sec = await security.finish(scan);
  log.info(
    { findings: sec.summary.totals.findings, secrets: sec.summary.totals.secrets, ms: sec.summary.durationMs },
    "security analysis complete",
  );

  const fileImports = code.files.map((f) => ({ path: f.path, language: f.language, imports: f.metrics.imports, codeLines: f.metrics.codeLines }));

  await stage("DEPENDENCIES");
  // The OSV.dev lookup never throws: an outage is recorded in the summary and the analysis continues.
  const dep = await analyzeDependencies(scan.files, { osv: opts.osv, imports: fileImports });
  log.info(
    {
      dependencies: dep.summary.totals.dependencies,
      vulnerable: dep.summary.totals.vulnerable,
      osv: dep.summary.vulnerabilityScan.status,
      ms: dep.summary.durationMs,
    },
    "dependency analysis complete",
  );

  await stage("ARCHITECTURE");
  const arch = await analyzeArchitecture(scan.files, fileImports, new Map(scan.files.map((f) => [f.path, f.kind])));
  log.info(
    { files: arch.summary.totals.files, edges: arch.summary.totals.edges, cycles: arch.summary.totals.cycles, ms: arch.summary.durationMs },
    "architecture analysis complete",
  );

  await stage("PRACTICES");
  const practices = await analyzePractices(scan, code, { root });
  log.info(
    {
      endpoints: practices.summary.api.endpoints,
      testFiles: practices.summary.testing.testFiles,
      findings: practices.summary.findings.total,
      ms: practices.summary.durationMs,
    },
    "API, database, testing and documentation analysis complete",
  );

  const findings: AnalyzerFinding[] = [...code.findings, ...sec.findings, ...dep.findings, ...arch.findings, ...practices.findings];
  const health = computeHealthScore({
    findings,
    excludedFingerprints: new Set(opts.excludedFingerprints ? await opts.excludedFingerprints() : []),
    productionCodeLines: practices.summary.testing.sourceCodeLines,
    duplicationPercent: code.summary.totals.duplicationPercent,
    present: {
      code: code.summary.totals.sourceFiles > 0,
      dependencies: dep.summary.manifests.length > 0,
      architecture: arch.summary.totals.files > 0,
      api: practices.summary.api.endpoints > 0,
      database: practices.summary.database.detected,
    },
    vulnerabilityScan: dep.summary.vulnerabilityScan,
    coverageMeasured: practices.summary.testing.coverage !== null,
  });
  log.info({ score: health.score, grade: health.grade, excluded: health.excludedFindings }, "health score computed");

  await stage("INDEXING");
  const index = await buildRepositoryIndex(scan, code, symbolCollector.files(), { name: opts.name, moduleDepth: arch.summary.moduleDepth });
  log.info(
    { symbols: index.summary.totals.symbols, references: index.summary.totals.references, dependencies: index.summary.totals.dependencies, ms: index.summary.durationMs },
    "repository index built",
  );

  return { scan, code, security: sec, dependencies: dep, architecture: arch, practices, findings, health, index };
}
