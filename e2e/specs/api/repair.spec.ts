import { expect, test } from "@playwright/test";
import { SANDBOX_EXPECTED } from "../../lib/env";
import { approvedRun, repairUser, type RunDto, stubRequests, waitForRun } from "../../lib/flows";

// The code engine's repair policy (M1) on the tiny-node-failing fixture, whose own tests always
// fail (a planted bug the stub's comment-only edits never fix). With E2E_SANDBOX=1 the tests run
// in the Docker sandbox against the real worker, PostgreSQL and the model stub:
// - without the user's consent, a failed test run goes to review: no repair model call, one test run;
// - with consent, repairs stop at the configured budget;
// - the run, its audit log and its report say exactly that.
// The specs use their own user, so their runs do not spend the owner's per-user engine budget.

test.describe.configure({ mode: "serial" });

interface Report {
  id: string;
  outcome: string;
  data: { run: { budgets: { maxIterations: number }; usage: { iterations: number }; execution: { repairApproved?: boolean | null; repairAttemptsAllowed?: number | null; repairAttemptsUsed?: number } } };
}

/** A run of a fresh approved plan for the failing fixture, waiting for the test approval (sandbox on) or in review (off). */
const runForApproval = async (task: string, maxIterations: number): Promise<RunDto> => (await approvedRun(repairUser(), "tiny-node-failing", task, maxIterations)).run;

const editRequests = async () => (await stubRequests()).filter((r) => r.kind === "edit").length;

async function runReport(runId: string) {
  const user = repairUser();
  const created = await user.post<Report>("/api/reports", { type: "RUN", subjectId: runId });
  expect([200, 201]).toContain(created.status);
  const report = (await user.get<Report>(`/api/reports/${created.data.id}`)).data;
  const markdown = (await user.get(`/api/reports/${created.data.id}/export?format=markdown`)).text;
  return { report, markdown };
}

test("with the sandbox off, a run of the failing fixture executes nothing and records no repair decision", async () => {
  test.skip(SANDBOX_EXPECTED, "Covered with the sandbox on by the specs below.");
  const run = await runForApproval("Document the subtract function in src/math.js with a short comment.", 2);
  expect(run.status).toBe("READY_FOR_REVIEW");
  expect(run.executions).toEqual([]);
  expect(run.repair).toEqual({ approved: null, attemptsAllowed: null, attemptsUsed: 0 });
});

test.describe("with the sandbox", () => {
  test.skip(!SANDBOX_EXPECTED, "Needs the Docker sandbox (E2E_SANDBOX=1).");

  test("without repair consent, failing tests go to review: no repair model call, one test run", async () => {
    const user = repairUser();
    let run = await runForApproval("Document the subtract function in src/math.js with a short comment.", 3);
    expect(run.status).toBe("AWAITING_APPROVAL");
    expect(run.testSetup?.needsInstall).toBe(false);
    const editsBefore = await editRequests();

    // The UI's default: repair left unticked (the API defaults it to false as well).
    expect((await user.post(`/api/engineering/runs/${run.id}/execute`, { install: false, repair: false })).status).toBe(200);
    run = await waitForRun(user, run.id, ["READY_FOR_REVIEW"]);

    expect(run.status).toBe("READY_FOR_REVIEW");
    expect(await editRequests()).toBe(editsBefore); // no repair model call
    const tests = run.executions.filter((e) => e.kind === "TEST");
    expect(tests).toHaveLength(1); // one sandbox session
    expect(tests[0]).toMatchObject({ iteration: 1, network: false, timedOut: false });
    expect(tests[0]!.exitCode).not.toBe(0);
    expect(run).toMatchObject({ iteration: 1, maxIterations: 3, hasPatch: true });
    expect(run.repair).toEqual({ approved: false, attemptsAllowed: 0, attemptsUsed: 0 });

    // Audit log: the approval records the refusal; no repair; the final message says why.
    const statuses = run.events.filter((e) => e.type === "status");
    expect(statuses.map((e) => e.toStatus)).not.toContain("REPAIRING");
    expect(statuses.filter((e) => e.toStatus === "TESTING")).toHaveLength(1);
    expect(statuses.find((e) => e.actor === "user" && e.fromStatus === "AWAITING_APPROVAL")!.message).toMatch(/Repair attempts not allowed/);
    expect(statuses.at(-1)!.message).toBe(`The tests failed (exit code ${tests[0]!.exitCode}). Ready for review (repair attempts were not approved; not repaired).`);

    // The report says the same.
    const { report, markdown } = await runReport(run.id);
    expect(report.outcome).toBe("TESTS_FAILED");
    expect(report.data.run.execution).toMatchObject({ repairApproved: false, repairAttemptsAllowed: 0, repairAttemptsUsed: 0 });
    expect(report.data.run.budgets.maxIterations).toBe(3);
    expect(markdown).toContain("Repair attempts after failing tests: not allowed; 0 used");
    expect(markdown).toContain("Iterations: 1 used of 3 configured");
  });

  test("with repair consent, repairs stop at the configured budget", async () => {
    const user = repairUser();
    let run = await runForApproval("Document the add function in src/math.js with a short comment.", 2);
    expect(run.status).toBe("AWAITING_APPROVAL");
    const editsBefore = await editRequests();

    expect((await user.post(`/api/engineering/runs/${run.id}/execute`, { install: false, repair: true })).status).toBe(200);
    run = await waitForRun(user, run.id, ["READY_FOR_REVIEW"]);

    // Budget 2: the first change plus exactly one repair. The tests still fail, and nothing more is tried.
    expect(run.status).toBe("READY_FOR_REVIEW");
    expect(await editRequests()).toBe(editsBefore + 1);
    const tests = run.executions.filter((e) => e.kind === "TEST");
    expect(tests.map((e) => e.iteration)).toEqual([1, 2]);
    expect(tests.every((e) => e.exitCode !== 0 && !e.network)).toBe(true);
    expect(run).toMatchObject({ iteration: 2, maxIterations: 2 });
    expect(run.repair).toEqual({ approved: true, attemptsAllowed: 1, attemptsUsed: 1 });

    const statuses = run.events.filter((e) => e.type === "status");
    expect(statuses.filter((e) => e.fromStatus === "TESTING" && e.toStatus === "REPAIRING")).toHaveLength(1);
    expect(statuses.find((e) => e.actor === "user" && e.fromStatus === "AWAITING_APPROVAL")!.message).toMatch(/Repair attempts allowed if the tests fail \(up to 1\)/);
    expect(statuses.at(-1)!.message).toBe(`The tests failed (exit code ${tests[1]!.exitCode}). Ready for review, no repair attempts left.`);

    const { report, markdown } = await runReport(run.id);
    expect(report.outcome).toBe("TESTS_FAILED");
    expect(report.data.run.execution).toMatchObject({ repairApproved: true, repairAttemptsAllowed: 1, repairAttemptsUsed: 1 });
    expect(report.data.run.usage.iterations).toBe(2);
    expect(markdown).toContain("Repair attempts after failing tests: allowed by the user, up to 1; 1 used");
    expect(markdown).toContain("Iterations: 2 used of 2 configured");
  });
});
