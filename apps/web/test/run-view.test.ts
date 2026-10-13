import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunPanel } from "@/components/planner/run-panel";
import { RUN_STATUS, RunView, type RunDto } from "@/components/planner/run-view";

const DIFF = 'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,3 +1,3 @@\n export function login(user: string) {\n-  return user.length > 0;\n+  return user.trim().length > 0;\n }\n';

function run(extra: Partial<RunDto> = {}): RunDto {
  return {
    id: "run1",
    status: "AWAITING_APPROVAL",
    inProgress: false,
    provider: "anthropic",
    model: "claude-opus-5-5",
    commitSha: null,
    maxIterations: 2,
    tokenBudget: 200000,
    iteration: 1,
    inputTokens: 1200,
    outputTokens: 300,
    installApproved: false,
    executionApprovedAt: null,
    cancelRequestedAt: null,
    failureReason: null,
    error: null,
    createdAt: "2026-10-03T10:00:00.000Z",
    finishedAt: null,
    summary: "Trims the user name.",
    notes: ["Check callers that pass padded names."],
    hasPatch: true,
    repair: { approved: null, attemptsAllowed: null, attemptsUsed: 0 },
    testSetup: {
      id: "npm",
      runtime: "node",
      image: "node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6",
      needsInstall: true,
      notes: ["package.json defines a test script."],
      install: { id: "npm-ci", command: "npm ci --ignore-scripts --no-audit --no-fund --loglevel=error" },
      test: { id: "npm-test", command: "npm test" },
    },
    sandbox: { enabled: true, installEnabled: true },
    events: [
      { type: "created", actor: "user", fromStatus: null, toStatus: "QUEUED", message: "Run started for the approved plan.", createdAt: "2026-10-03T10:00:00.000Z" },
      { type: "status", actor: "worker", fromStatus: "APPLYING", toStatus: "AWAITING_APPROVAL", message: "Waiting for approval to run npm test in the sandbox.", createdAt: "2026-10-03T10:00:09.000Z" },
    ],
    changes: [
      { iteration: 1, path: "src/auth.ts", operation: "MODIFY", status: "APPLIED", reason: "Trim.", additions: 1, deletions: 1, flags: [], diff: DIFF },
      { iteration: 1, path: ".github/workflows/ci.yml", operation: "MODIFY", status: "REJECTED", reason: "Run tests on PRs.", additions: 0, deletions: 0, flags: ["forbidden-path"], diff: null },
    ],
    executions: [],
    ...extra,
  };
}

const noop = { approve() {}, skip() {}, cancel() {}, discard() {} };
const render = (r: RunDto, withActions = true) => renderToStaticMarkup(createElement(RunView, { run: r, actions: withActions ? noop : undefined }));

describe("RunView", () => {
  it("asks for approval with the exact command, the image, and the install step as a separate opt-in with a network warning", () => {
    const html = render(run());
    expect(html).toContain("Waiting for your approval");
    expect(html).toContain("Run the tests in the sandbox?");
    expect(html).toContain("npm test");
    expect(html).toContain("node:24-slim@sha256:0e0ff40c");
    expect(html).toContain("Also install dependencies first");
    expect(html).toContain("npm ci --ignore-scripts");
    expect(html).toContain("This step has network access");
    expect(html).toContain("Approve and run tests");
    expect(html).toContain("Skip tests and review");
    expect(html).toContain("Cancel run");
    // No download before review.
    expect(html).not.toContain("Download patch");
  });

  it("offers repair attempts as a separate opt-in, off by default, and says what a repair does", () => {
    const html = render(run());
    expect(html).toContain("Allow up to 1 repair attempt if the tests fail");
    expect(html).toContain("without showing you the");
    expect(html).toContain("Left off, a test failure goes to review as it is.");
    // Both opt-ins (install and repair) render unchecked.
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
    // No decision is shown before the approval.
    expect(html).not.toContain("Repair attempts after failing tests");

    expect(render(run({ maxIterations: 3 }))).toContain("Allow up to 2 repair attempts if the tests fail");
    const noBudget = render(run({ maxIterations: 1 }));
    expect(noBudget).not.toContain("Allow up to");
    expect(noBudget).toContain("budget has no repair attempts left");
  });

  it("shows the recorded repair decision with the attempts allowed and used after the approval", () => {
    const tested = { status: "TESTING" as const, inProgress: true, executionApprovedAt: "2026-10-03T10:01:00.000Z" };
    expect(render(run({ ...tested, repair: { approved: false, attemptsAllowed: 0, attemptsUsed: 0 } }))).toContain(
      "Repair attempts after failing tests: not allowed (0 used). A test failure goes to review as it is.",
    );
    expect(render(run({ ...tested, iteration: 2, repair: { approved: true, attemptsAllowed: 1, attemptsUsed: 1 } }))).toContain("Repair attempts after failing tests: allowed by you, up to 1; 1 used.");
  });

  it("shows iterations used against the configured budget, never a capped or misleading total", () => {
    // Without repair consent the configured budget stays as configured: "1 used of 2", not "1 of 1".
    const html = render(run({ status: "READY_FOR_REVIEW", maxIterations: 2, iteration: 1, executionApprovedAt: "2026-10-03T10:01:00.000Z", repair: { approved: false, attemptsAllowed: 0, attemptsUsed: 0 } }));
    expect(html).toContain("Iterations: 1 used of 2 configured");
    expect(html).not.toMatch(/Iteration 1 of 1|1 of 1/);
    expect(render(run({ maxIterations: 3, iteration: 2 }))).toContain("Iterations: 2 used of 3 configured");
  });

  it("does not offer the install step when the server disables it, and warns that tests may fail", () => {
    const html = render(run({ sandbox: { enabled: true, installEnabled: false } }));
    expect(html).not.toContain("Also install dependencies first");
    expect(html).toContain("the install step is disabled on this server");
  });

  it("shows applied and rejected changes with their diffs and flags, as text", () => {
    const html = render(run());
    expect(html).toContain("src/auth.ts");
    expect(html).toContain("+  return user.trim().length &gt; 0;");
    expect(html).toContain("never editable");
    expect(html).toContain("rejected");
    expect(html).toContain("1 applied in the last iteration, 1 rejected in total");
    // Diff text is escaped, never markup.
    const hostile = render(run({ changes: [{ iteration: 1, path: "a.ts", operation: "MODIFY", status: "APPLIED", reason: "<img src=x onerror=alert(1)>", additions: 1, deletions: 0, flags: [], diff: "+<script>alert(1)</script>\n" }] }));
    expect(hostile).not.toContain("<script>");
    expect(hostile).not.toContain("<img");
    expect(hostile).toContain("&lt;script&gt;");
  });

  it("offers the download and discard when ready for review, with test results", () => {
    const html = render(
      run({
        status: "READY_FOR_REVIEW",
        executionApprovedAt: "2026-10-03T10:01:00.000Z",
        executions: [{ iteration: 1, kind: "TEST", command: "npm test", image: "node:24-slim@sha256:0e0f", network: false, exitCode: 0, timedOut: false, durationMs: 4200, output: "1 passed\n", outputTruncated: false }],
      }),
    );
    expect(html).toContain("Ready for review");
    expect(html).toContain('href="/api/engineering/runs/run1/patch"');
    expect(html).toContain("Download patch");
    expect(html).toContain("Discard");
    expect(html).toContain("exit 0");
    expect(html).toContain("1 passed");
    expect(html).toContain("Nothing was committed or pushed");
    expect(html).not.toContain("Run the tests in the sandbox?");
    expect(html).not.toContain("Cancel run");
  });

  it("shows progress and failures", () => {
    const busy = render(run({ status: "TESTING", inProgress: true, executionApprovedAt: "x" }));
    expect(busy).toContain("Running tests");
    expect(busy).toContain("Cancel run");
    const failed = render(run({ status: "FAILED", error: "The rebuilt source does not match the analysis; run a new analysis.", testSetup: null }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("does not match the analysis");
    expect(failed).not.toContain("Download patch");
  });

  it("labels every lifecycle status", () => {
    expect(Object.keys(RUN_STATUS)).toHaveLength(13);
  });
});

describe("RunPanel", () => {
  it("asks for plan approval first, explaining what the code engine will and will not do", () => {
    const html = renderToStaticMarkup(createElement(RunPanel, { planId: "p1", approvedAt: null }));
    expect(html).toContain("Approve plan");
    expect(html).toContain("Nothing is committed or pushed");
  });

  it("offers to run the code engine once the plan is approved", () => {
    const html = renderToStaticMarkup(createElement(RunPanel, { planId: "p1", approvedAt: "2026-10-03T10:00:00.000Z" }));
    expect(html).toContain("Plan approved");
    expect(html).toContain("Run the code engine");
  });
});
