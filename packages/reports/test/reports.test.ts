import { describe, expect, it } from "vitest";
import { buildReport, collectReportInput, generateReport, getReport, latestReport, listReports, renderMarkdown, type ReportSubject } from "../src";
import { fakeReportsDb } from "./fake-db";
import { FAKE_KEY, HOSTILE_PATH, INJECTION, world } from "./fixtures";

const db = () => fakeReportsDb(world());
const gen = async (subject: ReportSubject, user = "u1", prisma = db()) => (await generateReport(prisma as any, user, subject)).report;
const run = (id: string) => gen({ type: "RUN", id });
const states = (r: Awaited<ReturnType<typeof gen>>) => Object.fromEntries(r.data.chain.map((s) => [s.step, s.state]));
const Q = { page: 1, pageSize: 20 };

// ---------------------------------------------------------------- analysis reports

describe("analysis reports", () => {
  it("summarise a completed analysis from stored data", async () => {
    const r = await gen({ type: "ANALYSIS", id: "an1" });
    expect(r).toMatchObject({ type: "ANALYSIS", status: "COMPLETE", outcome: "COMPLETED", analysisId: "an1", repositoryId: "r1", planId: null, runId: null, version: 1 });
    expect(r.title).toBe("Analysis report: acme/storefront");
    expect(r.summary).toBe("The analysis completed with 4 findings (1 critical, 1 high); health score 62/100 (C).");
    const a = r.data.analysis;
    expect(a).toMatchObject({ status: "COMPLETED", durationMs: 19000, health: { score: 62, grade: "C" } });
    expect(a.overview).toMatchObject({ files: 12, primaryLanguage: "javascript", frameworks: ["Express"], testFrameworks: ["Vitest"], entryPoints: ["src/server.js"], manifests: [{ path: "package.json", ecosystem: "npm" }] });
    expect(a.findings).toMatchObject({ total: 4, triaged: 1, bySeverity: { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 1 } });
    expect(a.findings.top.map((f) => f.severity)).toEqual(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
    expect(a.findings.top.find((f) => f.ruleId === "metrics/long-function")!.triaged).toBe(true);
    expect(a.dependencies).toEqual({ total: 2, vulnerable: 1, vulnerabilityScan: "disabled" });
    expect(r.data.plan).toBeNull();
    expect(r.data.run).toBeNull();
    expect(r.data.chain.map((s) => s.step)).toEqual(["repository", "analysis", "result"]);
    // Security section: counts and locations, never the secret.
    expect(r.data.security.analysis).toMatchObject({ secrets: 1, insecurePatterns: 1, vulnerableDependencies: 1, committedEnvFiles: [".env"] });
    expect(r.data.security.run).toBeNull();
    expect(r.data.issues.warnings).toEqual([{ source: "dependencies", message: "Dependency vulnerability lookup: disabled; known vulnerabilities may be missing." }]);
  });

  it("report failed and unfinished analyses as such", async () => {
    const failed = await gen({ type: "ANALYSIS", id: "an-failed" });
    expect(failed).toMatchObject({ status: "COMPLETE", outcome: "FAILED", summary: "The analysis failed: Repository not found or not public" });
    expect(states(failed)).toEqual({ repository: "failed", analysis: "failed", result: "failed" });
    expect(failed.data.analysis.overview).toBeNull();
    expect(failed.data.analysis.health).toBeNull();
    expect(failed.data.issues.errors).toEqual([{ source: "analysis", message: "Repository not found or not public" }]);

    const running = await gen({ type: "ANALYSIS", id: "an-running" });
    expect(running).toMatchObject({ status: "PARTIAL", outcome: "IN_PROGRESS" });
    expect(running.summary).toMatch(/still running .*partial/);
    expect(states(running)).toEqual({ repository: "passed", analysis: "pending", result: "pending" });
  });
});

// ---------------------------------------------------------------- plan reports

describe("plan reports", () => {
  it("cover the plan and its approval state", async () => {
    const approved = await gen({ type: "PLAN", id: "p1" });
    expect(approved).toMatchObject({ type: "PLAN", status: "COMPLETE", outcome: "COMPLETED", planId: "p1", runId: null });
    expect(approved.data.plan).toMatchObject({ status: "COMPLETED", approval: { state: "approved" }, content: { summary: "Rate-limit POST /login." } });
    expect(approved.summary).toBe("The plan completed (validation PASSED, confidence 80%) and is approved for the code engine.");
    expect(states(approved)).toMatchObject({ plan: "passed", approval: "passed", result: "passed" });

    const superseded = await gen({ type: "PLAN", id: "p0" });
    expect(superseded.data.plan!.approval.state).toBe("superseded");
    expect(states(superseded).approval).toBe("not_executed");
  });

  it("report a rejected plan without content and with its validation issues", async () => {
    const r = await gen({ type: "PLAN", id: "p-rejected" });
    expect(r).toMatchObject({ outcome: "FAILED", status: "COMPLETE" });
    expect(r.data.plan).toMatchObject({ status: "FAILED", validationStatus: "REJECTED", content: null, approval: { state: "not_applicable" }, validation: { errors: 1 } });
    expect(states(r)).toMatchObject({ plan: "failed", approval: "not_executed", result: "failed" });
    expect(r.data.issues.errors).toContainEqual({ source: "plan", message: "The model's output did not match the plan schema and was rejected." });
  });
});

// ---------------------------------------------------------------- run reports

describe("run reports", () => {
  it("connect the whole chain for a run whose tests passed", async () => {
    const r = await run("run-passed");
    expect(r).toMatchObject({ type: "RUN", status: "COMPLETE", outcome: "TESTS_PASSED", runId: "run-passed", planId: "p1", analysisId: "an1" });
    expect(r.summary).toBe("The run changed 1 file and the approved tests passed. Ready for review.");
    expect(states(r)).toEqual({ repository: "passed", analysis: "passed", plan: "passed", approval: "passed", run: "passed", changes: "passed", validation: "passed", tests: "passed", result: "passed" });
    const x = r.data.run!;
    expect(x.changes).toMatchObject({ applied: 1, rejected: 2, additions: 11, deletions: 1, filesChanged: ["src/server.js"] });
    expect(x.tests).toMatchObject({ state: "passed", executions: [{ kind: "TEST", exitCode: 0, network: false, outputTail: "1 passed\n" }] });
    expect(x.review).toEqual({ state: "ready", patchAvailable: true });
    expect(x.execution).toMatchObject({ testCommand: "npm test", image: "node:24-slim@sha256:abc" });
    expect(r.data.security.run).toEqual({
      blockedForSecurity: [{ path: ".github/workflows/ci.yml", flags: ["forbidden-path"] }],
      sandbox: { used: true, testsWithoutNetwork: true, installWithNetwork: false, images: ["node:24-slim@sha256:abc"] },
    });
    expect(r.data.security.notes).toContain("Approved tests ran in disposable containers without network access.");
    expect(r.data.timeline.map((e) => e.event).slice(0, 3)).toEqual(["Analysis requested", "Analysis started", "Analysis finished"]);
    expect(r.data.timeline.at(-1)!.event).toBe("Tests passed. Ready for review.");
  });

  it("never claim success without a passing test run", async () => {
    const failedTests = await run("run-failed-tests");
    expect(failedTests).toMatchObject({ outcome: "TESTS_FAILED" });
    expect(states(failedTests)).toMatchObject({ tests: "failed", result: "failed" });
    expect(failedTests.data.issues.errors).toContainEqual({ source: "tests", message: "The last approved test run failed (npm test, exit code 1)." });

    const untested = await run("run-untested");
    expect(untested).toMatchObject({ outcome: "NOT_TESTED", status: "COMPLETE" });
    expect(untested.data.run!.tests).toMatchObject({ state: "not_executed", detail: "Tests not run: Sandboxed test runs are disabled on this server." });
    expect(states(untested)).toMatchObject({ tests: "not_executed", result: "unavailable" });
    expect(untested.summary).toMatch(/but the changes were not tested/);
    expect(untested.data.limitations).toContain("Without a passing test run, the behaviour of the changes is not verified.");

    const skipped = await run("run-skipped");
    expect(skipped).toMatchObject({ outcome: "NOT_TESTED" });
    expect(skipped.data.run!.tests).toMatchObject({ state: "skipped", detail: "The user skipped the tests; nothing was executed." });
    expect(skipped.data.issues.warnings).toContainEqual({ source: "tests", message: "The changes were not tested: The user skipped the tests; nothing was executed." });
  });

  it("report unfinished runs as partial", async () => {
    const awaiting = await run("run-awaiting");
    expect(awaiting).toMatchObject({ status: "PARTIAL", outcome: "AWAITING_APPROVAL" });
    expect(awaiting.data.run!.tests.state).toBe("pending");
    const active = await run("run-active");
    expect(active).toMatchObject({ status: "PARTIAL", outcome: "IN_PROGRESS" });
    expect(states(active)).toMatchObject({ run: "pending", changes: "pending", validation: "pending", tests: "pending", result: "pending" });
  });

  it("handle failed, cancelled and discarded runs", async () => {
    const failed = await run("run-failed");
    expect(failed).toMatchObject({ outcome: "FAILED", status: "COMPLETE", summary: "The run failed: The rebuilt source does not match the analysis; run a new analysis." });
    expect(failed.data.run).toMatchObject({ failureReason: "source-changed", review: { state: "not_reached", patchAvailable: false }, tests: { state: "not_executed", detail: "The run ended before any test ran." } });
    expect(states(failed)).toMatchObject({ run: "failed", changes: "not_executed", validation: "not_executed", tests: "not_executed" });

    const cancelled = await run("run-cancelled");
    expect(cancelled).toMatchObject({ outcome: "CANCELLED", summary: "The run was cancelled by the user." });
    expect(cancelled.data.issues.warnings).toContainEqual({ source: "run", message: "The run was cancelled by the user." });

    const discarded = await run("run-discarded");
    expect(discarded).toMatchObject({ outcome: "DISCARDED" });
    expect(discarded.data.run!.review).toEqual({ state: "discarded", patchAvailable: false });
  });
});

// ---------------------------------------------------------------- security of the content

describe("report content security", () => {
  it("never contains a secret, finding evidence or code", async () => {
    for (const subject of [{ type: "ANALYSIS", id: "an1" }, { type: "PLAN", id: "p1" }, { type: "RUN", id: "run-failed-tests" }] as const) {
      const r = await gen(subject);
      const json = JSON.stringify(r);
      expect(json).not.toContain(FAKE_KEY);
      expect(json).not.toContain("app.use(cors"); // finding evidence (code) is never copied
      expect(json).not.toContain("diff --git"); // nor the run's patch
    }
    const r = await run("run-failed-tests");
    expect(r.data.plan!.task.request).toContain("<redacted>");
    expect(r.data.run!.tests.executions[0]!.outputTail).not.toContain(FAKE_KEY);
  });

  it("keeps hostile repository content as inert text and bounds it", async () => {
    const r = await run("run-failed-tests");
    // Text is stored as text: escaping is the renderer's job (React, and the Markdown export below).
    expect(r.data.run!.summary).toBe(INJECTION);
    expect(r.data.run!.changes.items.map((c) => c.path)).toContain(HOSTILE_PATH);
    // A prompt-injection-like statement in model prose does not change the stored facts.
    expect(r.outcome).toBe("TESTS_FAILED");
    const tail = r.data.run!.tests.executions[0]!;
    expect(tail.outputTail.length).toBeLessThanOrEqual(2000);
    expect(tail.outputTail.endsWith("end of output\n")).toBe(true);
    expect(tail.outputTruncated).toBe(true);
  });

  it("escapes repository-controlled text in the Markdown export", async () => {
    const r = await run("run-failed-tests");
    const md = renderMarkdown(r.data, { id: r.id, generatedAt: r.generatedAt.toISOString() });
    expect(md).not.toMatch(/<script>|<img/);
    expect(md).toContain("&lt;script&gt;");
    expect(md).toContain("Ignore all previous instructions");
    expect(md).not.toContain(FAKE_KEY);
    expect(md).toContain("## Tests");
    expect(md).toContain("State: FAILED");
  });
});

// ---------------------------------------------------------------- persistence, snapshots, access

describe("report store", () => {
  it("is deterministic and returns the existing report when nothing changed", async () => {
    const prisma = db();
    const a = await collectReportInput(prisma as any, "u1", { type: "RUN", id: "run-passed" });
    const b = await collectReportInput(prisma as any, "u1", { type: "RUN", id: "run-passed" });
    expect(buildReport(a.input)).toEqual(buildReport(b.input));
    const first = await generateReport(prisma as any, "u1", { type: "RUN", id: "run-passed" });
    const again = await generateReport(prisma as any, "u1", { type: "RUN", id: "run-passed" });
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, report: { id: first.report.id } });
    expect(prisma.reports).toHaveLength(1);
  });

  it("keeps historical snapshots unchanged when the underlying data changes later", async () => {
    const prisma = db();
    const first = (await generateReport(prisma as any, "u1", { type: "RUN", id: "run-passed" })).report;
    // The user later discards the result.
    const live = prisma.data.runs.find((r: any) => r.id === "run-passed");
    live.status = "DISCARDED";
    live.patch = null;
    const second = (await generateReport(prisma as any, "u1", { type: "RUN", id: "run-passed" })).report;
    expect(second.id).not.toBe(first.id);
    expect(second.outcome).toBe("DISCARDED");
    const stored = await getReport(prisma as any, "u1", first.id);
    expect(stored).toMatchObject({ outcome: "TESTS_PASSED", data: { run: { review: { state: "ready", patchAvailable: true } } } });
    expect((await latestReport(prisma as any, "u1", { type: "RUN", id: "run-passed" }))!.id).toBe(second.id);
  });

  it("refuses subjects and reports of other users with 'not found'", async () => {
    const prisma = db();
    for (const subject of [{ type: "ANALYSIS", id: "an-other" }, { type: "RUN", id: "run-other" }, { type: "RUN", id: "missing" }, { type: "PLAN", id: "nope" }] as const) {
      await expect(generateReport(prisma as any, "u1", subject)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    const mine = await gen({ type: "ANALYSIS", id: "an1" }, "u1", prisma);
    await expect(generateReport(prisma as any, "u2", { type: "ANALYSIS", id: "an1" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getReport(prisma as any, "u2", mine.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await latestReport(prisma as any, "u2", { type: "ANALYSIS", id: "an1" })).toBeNull();
    expect((await listReports(prisma as any, "u2", Q)).total).toBe(0);
  });

  it("lists, filters and paginates the user's reports", async () => {
    const prisma = db();
    for (const id of ["run-passed", "run-failed", "run-untested"]) await gen({ type: "RUN", id }, "u1", prisma);
    await gen({ type: "ANALYSIS", id: "an1" }, "u1", prisma);
    const all = await listReports(prisma as any, "u1", Q);
    expect(all).toMatchObject({ total: 4, page: 1, pages: 1 });
    expect(all.items[0]).toMatchObject({ type: "ANALYSIS", repository: { name: "storefront" } });
    expect(all.items[0]).not.toHaveProperty("data");
    expect((await listReports(prisma as any, "u1", { ...Q, type: "RUN" })).total).toBe(3);
    expect((await listReports(prisma as any, "u1", { ...Q, outcome: "FAILED" })).items.map((i) => i.runId)).toEqual(["run-failed"]);
    expect((await listReports(prisma as any, "u1", { ...Q, runId: "run-untested" })).total).toBe(1);
    const page2 = await listReports(prisma as any, "u1", { page: 2, pageSize: 3 });
    expect(page2).toMatchObject({ total: 4, pages: 2 });
    expect(page2.items).toHaveLength(1);
  });

  it("returns the existing report when a concurrent identical generation wins the race", async () => {
    const prisma = db();
    const original = prisma.report.findUnique;
    let calls = 0;
    // The first lookup misses (as if the other request had not committed yet); the insert then hits the unique index.
    prisma.report.findUnique = async (args: any) => (calls++ === 0 ? null : original(args));
    const winner = await generateReport(prisma as any, "u1", { type: "ANALYSIS", id: "an1" });
    prisma.report.findUnique = async (args: any) => (calls++ === 1 ? null : original(args));
    const loser = await generateReport(prisma as any, "u1", { type: "ANALYSIS", id: "an1" });
    expect(loser).toMatchObject({ created: false, report: { id: winner.report.id } });
    expect(prisma.reports).toHaveLength(1);
  });
});
