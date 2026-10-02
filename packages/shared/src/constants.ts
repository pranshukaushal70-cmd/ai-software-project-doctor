export const SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const FINDING_CATEGORIES = [
  "CODE_QUALITY",
  "SECURITY",
  "SECRET",
  "DEPENDENCY",
  "ARCHITECTURE",
  "API",
  "DATABASE",
  "TESTING",
  "DOCUMENTATION",
  "GIT",
  "DEVOPS",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/** Ordered pipeline stages. The worker advances through these in order. */
export const ANALYSIS_STAGES = [
  { id: "QUEUED", label: "Queued" },
  { id: "CLONING", label: "Fetching repository" },
  { id: "SCANNING", label: "Scanning files" },
  { id: "PARSING", label: "Parsing source" },
  { id: "SECURITY", label: "Security analysis" },
  { id: "DEPENDENCIES", label: "Dependency analysis" },
  { id: "ARCHITECTURE", label: "Architecture analysis" },
  { id: "GIT", label: "Git analysis" },
  { id: "AI", label: "AI reasoning" },
  { id: "REPORT", label: "Report generation" },
  { id: "COMPLETED", label: "Completed" },
] as const;
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number]["id"];

export function stageProgress(stage: AnalysisStage): number {
  const index = ANALYSIS_STAGES.findIndex((s) => s.id === stage);
  return Math.round((index / (ANALYSIS_STAGES.length - 1)) * 100);
}

/** Package ecosystems the dependency analyzer reads (OSV.dev ecosystem names). */
export const DEPENDENCY_ECOSYSTEMS = ["npm", "PyPI", "Maven", "Go", "crates.io"] as const;
export type DependencyEcosystem = (typeof DEPENDENCY_ECOSYSTEMS)[number];

export const REPOSITORY_SOURCES = ["GITHUB", "GITLAB", "ZIP", "DEMO"] as const;
export type RepositorySource = (typeof REPOSITORY_SOURCES)[number];

export const ANALYSIS_QUEUE_NAME = "analysis";
