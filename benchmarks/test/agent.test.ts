import { describe, expect, it } from "vitest";
import { type Attempt, summarize } from "../src/agent";

const attempt = (task: string, plannerOk: boolean, engine: Partial<NonNullable<Attempt["engine"]>> | null): Attempt => ({
  fixture: "f",
  task,
  repetition: 1,
  planner: { status: plannerOk ? "COMPLETED" : "FAILED", validationStatus: plannerOk ? "PASSED" : null, model: "m", plannedFiles: [], fileRecall: plannerOk ? 1 : 0, filePrecision: null, inputTokens: null, outputTokens: null, durationMs: null, error: null, success: plannerOk },
  engine: engine && { status: "READY_FOR_REVIEW", applied: ["a.js"], rejected: 0, touchedExpected: true, touchedForbidden: [], testsRun: false, testsPassed: null, inputTokens: null, outputTokens: null, wallMs: 1, error: null, success: true, ...engine },
});

describe("agent evaluation summary", () => {
  it("rates the engine over all attempts, so failed plans count as end-to-end failures", () => {
    const s = summarize([attempt("t1", true, {}), attempt("t2", true, { success: false, status: "FAILED" }), attempt("t3", false, null), attempt("t1", true, { testsRun: true, testsPassed: true })]);
    expect(s.planner).toMatchObject({ completed: 3, successes: 3, successRate: 0.75 });
    expect(s.engine).toMatchObject({ started: 3, reachedReview: 2, testsRun: 1, testsPassed: 1, successes: 2, successRate: 0.5 });
    expect(s.perTask).toEqual([
      { task: "f/t1", attempts: 2, plannerSuccesses: 2, engineSuccesses: 2 },
      { task: "f/t2", attempts: 1, plannerSuccesses: 1, engineSuccesses: 0 },
      { task: "f/t3", attempts: 1, plannerSuccesses: 0, engineSuccesses: 0 },
    ]);
  });
});
