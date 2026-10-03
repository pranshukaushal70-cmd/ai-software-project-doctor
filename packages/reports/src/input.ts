import type { ReportTypeName } from "@pd/shared/constants";

/**
 * Everything a report is built from: rows as stored, loaded by collect.ts with
 * ownership checks. Plain data (no Prisma types), so the builder is pure and can
 * be tested without a database. JSON columns stay `unknown` and are read
 * defensively: older analyses and plans may lack fields.
 */
export interface ReportInput {
  type: ReportTypeName;
  repository: { id: string; name: string; owner: string | null; source: string; url: string | null; branch: string | null };
  analysis: {
    id: string;
    status: string;
    stage: string;
    analyzerVersion: string;
    commitSha: string | null;
    error: string | null;
    summary: unknown;
    healthScore: number | null;
    scoreBreakdown: unknown;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
  };
  findings: {
    total: number;
    triaged: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
    top: FindingRow[];
    security: FindingRow[];
  };
  dependencies: { total: number; vulnerable: number };
  plan: PlanInput | null;
  run: RunInput | null;
}

export interface FindingRow {
  severity: string;
  category: string;
  ruleId: string;
  title: string;
  path: string | null;
  line: number | null;
  triaged: boolean;
}

export interface PlanInput {
  id: string;
  status: string;
  provider: string;
  model: string;
  validationStatus: string | null;
  confidence: number | null;
  plan: unknown;
  validation: unknown;
  failureReason: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  approvedAt: Date | null;
  /** Whether this is the task's latest plan (only the latest can be approved). */
  isLatest: boolean;
  task: { id: string; request: string; scope: string | null; constraints: unknown; createdAt: Date };
}

export interface RunInput {
  id: string;
  status: string;
  provider: string;
  model: string;
  commitSha: string | null;
  maxIterations: number;
  tokenBudget: number;
  maxDurationSeconds: number;
  iteration: number;
  inputTokens: number;
  outputTokens: number;
  testCommand: string | null;
  installApproved: boolean;
  executionApprovedAt: Date | null;
  cancelRequestedAt: Date | null;
  failureReason: string | null;
  error: string | null;
  summary: string | null;
  notes: unknown;
  testSetup: unknown;
  hasPatch: boolean;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  events: Array<{ type: string; actor: string; fromStatus: string | null; toStatus: string | null; message: string; createdAt: Date }>;
  /** True when older events were left out (the list keeps the most recent). */
  eventsTruncated: boolean;
  changes: Array<{ iteration: number; path: string; operation: string; status: string; reason: string; additions: number; deletions: number; flags: unknown }>;
  changesTruncated: boolean;
  executions: Array<{
    iteration: number;
    kind: string;
    commandId: string;
    command: string;
    image: string;
    network: boolean;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number | null;
    output: string;
    outputTruncated: boolean;
  }>;
}
