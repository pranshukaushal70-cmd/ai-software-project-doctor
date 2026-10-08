import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { SANDBOX_EXPECTED } from "../../lib/env";
import { fixtureAnalysis, fixtureDir, plannedTask, type PlanDto, type RunDto, stubRequests, users, waitForRun } from "../../lib/flows";

// Phases 7–8: planner and code engine on the uploaded tiny-node fixture, with the real
// provider code talking to the deterministic model stub over HTTP. Every gate is checked;
// with E2E_SANDBOX=1 the fixture's tests also run in the Docker sandbox.

const STUB_MODEL = "e2e-model-stub";
const STUB_COMMENT = "Reviewed by the Project Doctor model stub (end-to-end tests).";

test.describe.configure({ mode: "serial" });

let analysisId: string;
let plan: PlanDto;
let run: RunDto;

test("the planner produces a validated plan grounded in the index", async () => {
  const { owner } = users();
  analysisId = (await fixtureAnalysis(owner, "tiny-node")).id;
  plan = (await plannedTask(owner, analysisId, "Document the add function in src/math.js with a short comment.")).plan;
  expect(plan.status, plan.error ?? "").toBe("COMPLETED");
  expect(plan.provider).toBe("anthropic");
  expect(plan.model).toBe(STUB_MODEL);
  expect(["PASSED", "WARNINGS"]).toContain(plan.validation?.status);
  expect(plan.plan?.affectedFiles).toEqual([expect.objectContaining({ path: "src/math.js", change: "modify" })]);

  // The planner sees the index (evidence), never file contents.
  const planRequest = (await stubRequests()).filter((r) => r.kind === "plan").at(-1)!;
  expect(planRequest.user).toContain("Document the add function");
  expect(planRequest.user).not.toContain("return a + b");
});

test("provider failures and refusals end the plan with a safe message", async () => {
  const { owner } = users();
  const failed = (await plannedTask(owner, analysisId, "Trigger a provider error [stub:error] for the e2e checks.")).plan;
  expect(failed.status).toBe("FAILED");
  expect(failed.error).toMatch(/AI provider returned an error/);
  const refused = (await plannedTask(owner, analysisId, "Trigger a model refusal [stub:refuse] for the e2e checks.")).plan;
  expect(refused.status).toBe("FAILED");
  expect(refused.error).toMatch(/declined/);
});

test("gate 1: no run without the owner's approval", async () => {
  const { owner, intruder } = users();
  expect((await owner.post(`/api/engineering/plans/${plan.id}/runs`)).status).toBe(409);
  expect((await intruder.post(`/api/engineering/plans/${plan.id}/approve`)).status).toBe(404);
  expect((await owner.post(`/api/engineering/plans/${plan.id}/approve`, undefined, { origin: "https://evil.example" })).status).toBe(403);

  const approved = await owner.post<{ approvedAt: string }>(`/api/engineering/plans/${plan.id}/approve`);
  expect(approved.status).toBe(200);
  const again = await owner.post<{ approvedAt: string }>(`/api/engineering/plans/${plan.id}/approve`);
  expect(again.data.approvedAt).toBe(approved.data.approvedAt);
  expect((await intruder.post(`/api/engineering/plans/${plan.id}/runs`)).status).toBe(404);
});

test("a run applies the model's edit to exactly the planned file", async () => {
  const { owner } = users();
  const started = await owner.post<RunDto>(`/api/engineering/plans/${plan.id}/runs`);
  expect(started.status).toBe(201);
  // One open run per plan.
  expect((await owner.post(`/api/engineering/plans/${plan.id}/runs`)).status).toBe(409);
  run = await waitForRun(owner, started.data.id, ["AWAITING_APPROVAL", "READY_FOR_REVIEW"]);

  expect(run.sandbox.enabled).toBe(SANDBOX_EXPECTED);
  expect(run.status).toBe(SANDBOX_EXPECTED ? "AWAITING_APPROVAL" : "READY_FOR_REVIEW");
  const applied = run.changes.filter((c) => c.status === "APPLIED");
  expect(applied.map((c) => c.path)).toEqual(["src/math.js"]);
  expect(applied[0]!.diff).toContain(STUB_COMMENT);

  // The editor's scope is the planned file and the existing test the plan names; nothing else is shown.
  const editRequest = (await stubRequests()).filter((r) => r.kind === "edit").at(-1)!;
  expect(editRequest.user).toMatch(/^- modify: src\/math\.js, test\/math\.test\.js$/m);
  expect(editRequest.user).toContain('<file path="src/math.js" purpose="modify">');
  expect(editRequest.user).not.toContain('<file path="README.md"');
  expect(editRequest.user).not.toContain('<file path="package.json"');
});

test("gate 2: tests run only after approval, in the sandbox", async () => {
  const { owner, intruder } = users();
  expect((await intruder.post(`/api/engineering/runs/${run.id}/execute`, { install: false })).status).toBe(404);
  // The network-enabled install step is off in every end-to-end configuration.
  expect((await owner.post(`/api/engineering/runs/${run.id}/execute`, { install: true })).status).toBe(409);
  if (!SANDBOX_EXPECTED) {
    // Sandbox off (the default): nothing can be executed and no repository code ran.
    expect((await owner.post(`/api/engineering/runs/${run.id}/execute`, { install: false })).status).toBe(409);
    expect(run.executions).toEqual([]);
    return;
  }
  expect(run.testSetup?.test?.command).toBe("npm test");
  expect(run.testSetup?.needsInstall).toBe(false);
  expect(run.executions).toEqual([]);
  expect((await owner.get(`/api/engineering/runs/${run.id}/patch`)).status).toBe(409);

  expect((await owner.post(`/api/engineering/runs/${run.id}/execute`, { install: false })).status).toBe(200);
  run = await waitForRun(owner, run.id, ["READY_FOR_REVIEW"]);
  expect(run.status).toBe("READY_FOR_REVIEW");
  const tests = run.executions.filter((e) => e.kind === "TEST");
  expect(tests).toHaveLength(1);
  expect(tests[0]).toMatchObject({ network: false, exitCode: 0, timedOut: false });
});

test("the patch downloads privately and applies to the analysed source", async () => {
  const { owner, intruder } = users();
  const res = await owner.get(`/api/engineering/runs/${run.id}/patch`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/x-diff");
  expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(res.text).toContain(STUB_COMMENT);
  expect((await intruder.get(`/api/engineering/runs/${run.id}/patch`)).status).toBe(404);

  const dir = mkdtempSync(path.join(os.tmpdir(), "pd-e2e-patch-"));
  try {
    cpSync(fixtureDir("tiny-node"), dir, { recursive: true });
    writeFileSync(path.join(dir, "run.patch"), res.text);
    execFileSync("git", ["apply", "--check", "run.patch"], { cwd: dir, stdio: "pipe" });
    execFileSync("git", ["apply", "run.patch"], { cwd: dir, stdio: "pipe" });
    // The changed fixture still passes its own tests.
    execFileSync(process.execPath, ["--test"], { cwd: dir, stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discarding deletes the stored result", async () => {
  const { owner } = users();
  expect((await owner.post(`/api/engineering/runs/${run.id}/discard`)).status).toBe(200);
  const after = await owner.get<RunDto>(`/api/engineering/runs/${run.id}`);
  expect(after.data.status).toBe("DISCARDED");
  expect(after.data.hasPatch).toBe(false);
  expect((await owner.get(`/api/engineering/runs/${run.id}/patch`)).status).toBe(409);
});
