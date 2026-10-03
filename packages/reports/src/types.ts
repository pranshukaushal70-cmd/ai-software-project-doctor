import type { ReportOutcomeName, ReportStatusName, ReportTypeName } from "@pd/shared/constants";

/**
 * The report snapshot (stored as Report.data). Versioned: REPORT_VERSION changes
 * whenever this shape changes, and every report records the version it was built
 * with, so historical reports stay readable. Everything in it was copied from
 * stored data at generation time (never inferred), bounded, and passed through
 * the secret redaction; it never contains file contents, diffs or finding evidence.
 * Dates are ISO strings; absent information is null, never a guess.
 */
export const REPORT_VERSION = 1;

/** How a check ended. "unavailable" means the data to tell does not exist; "not_executed" that it never ran. */
export type CheckState = "passed" | "failed" | "skipped" | "pending" | "not_executed" | "unavailable";

export interface ReportData {
  version: typeof REPORT_VERSION;
  type: ReportTypeName;
  status: ReportStatusName;
  outcome: ReportOutcomeName;
  title: string;
  summary: string;
  /** The chain from the repository to the subject, each step with its state (the overall Project Doctor view). */
  chain: ChainStep[];
  repository: RepositorySection;
  analysis: AnalysisSection;
  plan: PlanSection | null;
  run: RunSection | null;
  security: SecuritySection;
  issues: { errors: Issue[]; warnings: Issue[] };
  limitations: string[];
  timeline: TimelineEntry[];
}

export interface ChainStep {
  step: "repository" | "analysis" | "plan" | "approval" | "run" | "changes" | "validation" | "tests" | "result";
  state: CheckState;
  detail: string;
}

export interface Issue {
  source: "analysis" | "plan" | "run" | "validation" | "tests" | "dependencies" | "index";
  message: string;
}

export interface TimelineEntry {
  at: string;
  source: "analysis" | "plan" | "run";
  event: string;
  actor: string | null;
}

export interface RepositorySection {
  name: string;
  owner: string | null;
  source: string;
  url: string | null;
  branch: string | null;
  /** The commit the analysis was made from (git sources); null for uploads and the demo. */
  commitSha: string | null;
}

export interface FindingSummary {
  severity: string;
  category: string;
  ruleId: string;
  title: string;
  path: string | null;
  line: number | null;
  /** Marked Expected or Ignored by the user for this repository. */
  triaged: boolean;
}

export interface AnalysisSection {
  id: string;
  status: string;
  stage: string;
  analyzerVersion: string;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Null when the analysis has no score (not finished, or made before scoring existed). */
  health: { score: number; grade: string } | null;
  /** Null until the analysis produced a summary. */
  overview: {
    files: number | null;
    lines: number | null;
    primaryLanguage: string | null;
    languages: Array<{ language: string; files: number; lines: number }>;
    frameworks: string[];
    testFrameworks: string[];
    packageManagers: string[];
    buildSystems: string[];
    ci: string[];
    docker: string[];
    entryPoints: string[];
    sourceDirs: Array<{ path: string; files: number }>;
    testDirs: Array<{ path: string; files: number }>;
    manifests: Array<{ path: string; ecosystem: string }>;
    documentation: string[];
    modulesRun: string[];
  } | null;
  findings: {
    total: number;
    triaged: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
    /** The most severe findings (bounded); the full list stays with the analysis. */
    top: FindingSummary[];
  };
  dependencies: { total: number; vulnerable: number; vulnerabilityScan: string | null };
}

export interface PlanSection {
  id: string;
  task: { id: string; request: string; scope: string | null; constraints: string[]; createdAt: string };
  status: string;
  provider: string;
  model: string;
  createdAt: string;
  finishedAt: string | null;
  failureReason: string | null;
  error: string | null;
  validationStatus: string | null;
  confidence: number | null;
  approval: {
    /** approved; not_approved; superseded (a newer plan exists for the task); not_applicable (the plan did not complete). */
    state: "approved" | "not_approved" | "superseded" | "not_applicable";
    approvedAt: string | null;
  };
  /** Null when the plan produced no content (failed or still in progress). */
  content: {
    summary: string;
    interpretation: string;
    affectedFiles: Array<{ path: string; change: string; certainty: string; flags: string[] }>;
    steps: Array<{ title: string; files: string[] }>;
    tests: Array<{ description: string; path: string | null; kind: string }>;
    risks: Array<{ severity: string; description: string }>;
    unknowns: string[];
  } | null;
  validation: { errors: number; warnings: number; issues: Array<{ severity: string; code: string; message: string }> };
}

export interface ChangeSummary {
  iteration: number;
  path: string;
  operation: string;
  status: "APPLIED" | "REJECTED";
  additions: number;
  deletions: number;
  flags: string[];
  reason: string;
}

export interface ExecutionSummary {
  iteration: number;
  kind: string;
  command: string;
  image: string;
  network: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number | null;
  /** The end of the redacted output (bounded); the full output stays with the run. */
  outputTail: string;
  outputTruncated: boolean;
}

export interface RunSection {
  id: string;
  status: string;
  provider: string;
  model: string;
  commitSha: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  failureReason: string | null;
  error: string | null;
  cancelRequestedAt: string | null;
  budgets: { maxIterations: number; tokenBudget: number; maxDurationSeconds: number };
  usage: { iterations: number; inputTokens: number; outputTokens: number };
  summary: string | null;
  notes: string[];
  execution: {
    approvedAt: string | null;
    installApproved: boolean;
    testCommand: string | null;
    installCommand: string | null;
    image: string | null;
  };
  review: {
    /** ready: waiting for the user's review; discarded; not_reached (still in progress, failed or cancelled). */
    state: "ready" | "discarded" | "not_reached";
    /** Whether the run still stores its patch (downloadable from the run while ready for review). */
    patchAvailable: boolean;
  };
  changes: {
    applied: number;
    rejected: number;
    additions: number;
    deletions: number;
    /** Distinct paths with applied changes, i.e. the files the result changes. */
    filesChanged: string[];
    items: ChangeSummary[];
    truncated: boolean;
  };
  validation: {
    state: CheckState;
    iterations: Array<{ iteration: number; accepted: number; rejected: number }>;
    /** Rejected changes and why, including the security-relevant blocks. */
    blocked: Array<{ path: string; flags: string[]; reason: string }>;
  };
  tests: {
    state: CheckState;
    /** Why tests did not run, or how the last run ended, in words. */
    detail: string;
    executions: ExecutionSummary[];
  };
}

export interface SecuritySection {
  analysis: {
    secrets: number;
    insecurePatterns: number;
    vulnerableDependencies: number;
    committedEnvFiles: string[];
    /** Secret, security and dependency findings (bounded). Secret values are never included. */
    findings: FindingSummary[];
  };
  run: {
    /** Changes the code engine refused for security reasons (forbidden paths, credentials, redacted values, new findings). */
    blockedForSecurity: Array<{ path: string; flags: string[] }>;
    sandbox: { used: boolean; testsWithoutNetwork: boolean | null; installWithNetwork: boolean; images: string[] };
  } | null;
  notes: string[];
}

export interface BuiltReport {
  type: ReportTypeName;
  status: ReportStatusName;
  outcome: ReportOutcomeName;
  title: string;
  summary: string;
  errorCount: number;
  warningCount: number;
  data: ReportData;
  fingerprint: string;
}
