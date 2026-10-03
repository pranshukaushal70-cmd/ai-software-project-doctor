import type { ReportOutcomeName, ReportStatusName, ReportTypeName } from "@pd/shared/constants";

type Tone = "neutral" | "primary" | "ok" | "medium" | "critical";

/** Result labels. Only a verified result is "ok"; untested or unavailable results never look like success. */
export const OUTCOME: Record<ReportOutcomeName, { label: string; tone: Tone }> = {
  COMPLETED: { label: "Completed", tone: "ok" },
  TESTS_PASSED: { label: "Tests passed", tone: "ok" },
  TESTS_FAILED: { label: "Tests failed", tone: "critical" },
  NOT_TESTED: { label: "Not tested", tone: "medium" },
  DISCARDED: { label: "Discarded", tone: "neutral" },
  FAILED: { label: "Failed", tone: "critical" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  IN_PROGRESS: { label: "In progress", tone: "primary" },
  AWAITING_APPROVAL: { label: "Awaiting approval", tone: "medium" },
};

export const REPORT_STATUS: Record<ReportStatusName, { label: string; tone: Tone; help: string }> = {
  COMPLETE: { label: "Complete", tone: "neutral", help: "Everything this report covers had finished when it was generated." },
  PARTIAL: { label: "Partial", tone: "medium", help: "Something this report covers was still in progress; generate it again later." },
};

export const REPORT_TYPE: Record<ReportTypeName, string> = { ANALYSIS: "Analysis", PLAN: "Plan", RUN: "Run" };

export const CHECK: Record<string, { label: string; tone: Tone }> = {
  passed: { label: "Passed", tone: "ok" },
  failed: { label: "Failed", tone: "critical" },
  skipped: { label: "Skipped", tone: "neutral" },
  pending: { label: "Pending", tone: "primary" },
  not_executed: { label: "Not executed", tone: "medium" },
  unavailable: { label: "Unavailable", tone: "medium" },
};

export const STEP_LABEL: Record<string, string> = {
  repository: "Repository",
  analysis: "Analysis",
  plan: "Engineering plan",
  approval: "Approval",
  run: "Run",
  changes: "Generated changes",
  validation: "Validation",
  tests: "Tests",
  result: "Final result",
};
