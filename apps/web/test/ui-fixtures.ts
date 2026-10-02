import type { ArchitectureSummaryDto, DependencySummaryDto, HealthScoreDto, PracticesSummaryDto, ScanSummaryDto } from "@/components/analysis/types";

const severities = (over: Partial<Record<"CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO", number>> = {}) => ({
  CRITICAL: 0,
  HIGH: 0,
  MEDIUM: 0,
  LOW: 0,
  INFO: 0,
  ...over,
});

export function dependencySummary(over: Partial<DependencySummaryDto> = {}): DependencySummaryDto {
  return {
    analyzer: "dependencies",
    analyzerVersion: "0.4.0",
    manifests: [
      { path: "package-lock.json", ecosystem: "npm", kind: "lockfile", dependencies: 1 },
      { path: "package.json", ecosystem: "npm", kind: "manifest", dependencies: 2 },
    ],
    totals: {
      dependencies: 3,
      direct: 2,
      transitive: 1,
      dev: 0,
      resolved: 3,
      vulnerable: 1,
      vulnerableDirect: 1,
      advisories: 1,
      bySeverity: severities({ HIGH: 1 }),
      unpinned: 0,
      nonRegistry: 0,
      unusedCandidates: 1,
    },
    byEcosystem: [{ ecosystem: "npm", dependencies: 3, direct: 2, vulnerable: 1 }],
    vulnerabilityScan: { status: "completed", source: "osv.dev", queried: 3, notChecked: 0, error: null, durationMs: 120 },
    vulnerable: [
      {
        ecosystem: "npm",
        name: "lodash",
        version: "4.17.20",
        direct: true,
        dev: false,
        manifestPath: "package.json",
        severity: "HIGH",
        fixedVersion: "4.17.21",
        advisories: [
          {
            id: "GHSA-35jh-r3h4-6jhm",
            aliases: ["CVE-2021-23337"],
            summary: "Command Injection in lodash",
            severity: "HIGH",
            score: 7.2,
            url: "https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm",
          },
        ],
      },
    ],
    unusedCandidates: [{ name: "chalk", manifestPath: "package.json" }],
    dependencies: { total: 3, stored: 3, truncated: false },
    findings: { total: 2, stored: 2, truncated: false, bySeverity: severities({ HIGH: 1, INFO: 1 }), byType: { "vulnerable-dependency": 1, "unused-dependency": 1 } },
    errors: 0,
    durationMs: 140,
    ...over,
  };
}

export function architectureSummary(over: Partial<ArchitectureSummaryDto> = {}): ArchitectureSummaryDto {
  return {
    analyzer: "architecture",
    analyzerVersion: "0.4.0",
    thresholds: { fanOut: { low: 20, medium: 40 }, largeCycleFiles: 10, maxModules: 30 },
    totals: {
      files: 4,
      edges: 4,
      internalImports: 4,
      externalImports: 2,
      builtinImports: 1,
      unresolvedImports: 1,
      cycles: 1,
      filesInCycles: 2,
      modules: 3,
      moduleEdges: 1,
      layerViolations: 0,
      isolatedFiles: 1,
      maxFanIn: 2,
      maxFanOut: 2,
      avgFanOut: 1,
    },
    byLanguage: [{ language: "typescript", files: 4, edges: 4, unresolved: 1 }],
    moduleDepth: 2,
    modules: [
      { key: "src/core", label: "core", files: 2, loc: 40, fanIn: 1, fanOut: 0, instability: 0, layer: null, inCycle: false },
      { key: "src/api", label: "api", files: 1, loc: 20, fanIn: 0, fanOut: 1, instability: 1, layer: "interface", inCycle: false },
      { key: "lib", label: "lib", files: 1, loc: 5, fanIn: 0, fanOut: 0, instability: 0, layer: null, inCycle: false },
    ],
    moduleEdges: [{ from: "src/api", to: "src/core", weight: 2, inCycle: false }],
    cycles: [{ files: ["src/core/a.ts", "src/core/b.ts"], size: 2, path: ["src/core/a.ts", "src/core/b.ts", "src/core/a.ts"], severity: "MEDIUM" }],
    hubs: [{ path: "src/core/a.ts", fanIn: 2, fanOut: 1 }],
    mostDependent: [{ path: "src/api/handler.ts", fanIn: 0, fanOut: 2 }],
    layers: {
      applied: false,
      order: [
        { id: "interface", label: "Interface (UI / API)", files: 1 },
        { id: "service", label: "Services / domain logic", files: 0 },
        { id: "data", label: "Data access", files: 0 },
        { id: "shared", label: "Shared utilities", files: 0 },
      ],
      violations: 0,
    },
    topExternal: [{ name: "react", language: "typescript", files: 2 }],
    resolution: { tsconfigs: 1, pathAliases: 2, workspacePackages: 0, pythonRoots: [] },
    nodes: { total: 4, stored: 4, truncated: false },
    findings: { total: 1, stored: 1, truncated: false, bySeverity: severities({ MEDIUM: 1 }), byType: { "circular-dependency": 1 } },
    durationMs: 12,
    ...over,
  };
}

export function scanSummary(over: Partial<ScanSummaryDto> = {}): ScanSummaryDto {
  return {
    modulesRun: ["repository-scan", "code-metrics", "security", "dependencies", "architecture", "practices", "health-score"],
    ingest: { source: "ZIP" },
    totals: { files: 10, bytes: 2048, lines: 300, byKind: { SOURCE: 4, TEST: 1 } },
    languages: [{ language: "typescript", files: 5, lines: 300, bytes: 2048, analyzed: true }],
    primaryLanguage: "typescript",
    packageManagers: [],
    buildSystems: [],
    frameworks: [],
    ci: [],
    containers: [],
    envFiles: [],
    entryPoints: [],
    docs: { readme: "README.md", license: null, contributing: null, changelog: null, docsDir: false },
    ignored: { dirs: [], dirsTruncated: false, gitignoredFiles: 0, symlinksSkipped: 0, truncated: false },
    oversizedFiles: [],
    ...over,
  };
}

export function practicesSummary(over: Partial<PracticesSummaryDto> = {}): PracticesSummaryDto {
  return {
    analyzer: "practices",
    analyzerVersion: "0.5.0",
    thresholds: { apiSpecEndpoints: 5, noTestsHighLoc: 2000, noTestsMinLoc: 200, testRatio: { medium: 0.05, low: 0.2 }, coverage: { medium: 50, low: 70 }, untestedFileLoc: 150, readmeMinWords: 150 },
    api: {
      endpoints: 2,
      byMethod: { GET: 1, DELETE: 1 },
      frameworks: [{ name: "Express", endpoints: 2 }],
      list: [
        { method: "GET", path: "/products", file: "src/server.js", line: 8, framework: "Express", auth: false, readsBody: false, validated: false },
        { method: "DELETE", path: "/products/:id", file: "src/server.js", line: 12, framework: "Express", auth: false, readsBody: false, validated: false },
      ],
      listTruncated: false,
      mutating: 1,
      mutatingWithoutAuth: 1,
      bodyWithoutValidation: 0,
      globalAuth: null,
      rateLimiting: null,
      specFiles: [],
      specTooling: null,
    },
    database: {
      detected: true,
      technologies: [{ name: "Prisma", evidence: "prisma/schema.prisma" }],
      schemaFiles: ["prisma/schema.prisma"],
      models: 3,
      tables: 0,
      relations: 2,
      migrations: { tools: [], files: 0 },
      unindexedForeignKeys: 2,
      tablesWithoutPrimaryKey: 0,
      autoSchemaSync: [],
    },
    testing: {
      testFiles: 1,
      testCases: 2,
      sourceFiles: 6,
      testCodeLines: 10,
      sourceCodeLines: 400,
      testRatio: 0.03,
      frameworks: [{ name: "Vitest", evidence: "package.json: devDependencies.vitest" }],
      testScript: "vitest run",
      ci: { configured: false, runsTests: false, evidence: null },
      coverage: null,
      focused: 0,
      skipped: 1,
      referencedSourceFiles: 1,
      untested: [{ path: "src/orders.js", codeLines: 180 }],
    },
    documentation: {
      readme: { path: "README.md", words: 12, headings: 1, sections: { installation: true, usage: false, configuration: false, testing: false } },
      license: null,
      licenseDeclared: null,
      contributing: null,
      changelog: null,
      docsDir: false,
      markdownFiles: 1,
      envVars: { used: 3, documented: 1, undocumented: ["SMTP_HOST", "STRIPE_SECRET_KEY"], templates: [".env.example"] },
      links: { checked: 1, broken: 1 },
    },
    findings: {
      total: 9,
      stored: 9,
      truncated: false,
      bySeverity: severities({ MEDIUM: 1, LOW: 7, INFO: 1 }),
      byCategory: { API: 2, DATABASE: 3, TESTING: 2, DOCUMENTATION: 2 },
      byType: {},
    },
    errors: 0,
    durationMs: 12,
    ...over,
  };
}

const dimension = (id: string, label: string, weight: number, score: number | null, factors: HealthScoreDto["dimensions"][number]["factors"] = []) => ({
  id,
  label,
  weight,
  applicable: score !== null,
  score,
  effectiveWeight: score === null ? 0 : weight,
  factors,
  findings: factors.length,
  excluded: 0,
  note: score === null ? "No HTTP endpoints were detected." : null,
});

export function healthScore(over: Partial<HealthScoreDto> = {}): HealthScoreDto {
  return {
    version: "1.0",
    score: 62,
    grade: "C",
    weightedScore: 62,
    cap: null,
    dimensions: [
      dimension("security", "Security", 25, 55, [{ label: "3 high findings", points: -45, detail: "15 points each, at most 45." }]),
      dimension("codeQuality", "Code quality", 15, 94, [{ label: "1 medium finding in 0.4k lines", points: -6, detail: "6 points per finding per 1,000 lines of production code, at most 30." }]),
      dimension("dependencies", "Dependencies", 15, 100),
      dimension("testing", "Testing", 15, 20, [{ label: "No automated tests", points: -80, detail: "Fixed penalty of 80 points (testing/no-tests)." }]),
      dimension("architecture", "Architecture", 10, 100),
      dimension("documentation", "Documentation", 10, 96, [{ label: "2 low findings", points: -4, detail: "2 points each, at most 15." }]),
      dimension("api", "API", 5, null),
      dimension("database", "Database", 5, 100),
    ],
    caveats: ["No coverage report was found, so the testing score reflects how much test code exists, not how much code the tests execute."],
    excludedFindings: 0,
    ...over,
  };
}
