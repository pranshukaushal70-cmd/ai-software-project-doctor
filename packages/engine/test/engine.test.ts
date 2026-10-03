import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderError, ScriptedProvider, type EditOutput, type ValidatedPlan } from "@pd/agent";
import { uploadPath, uploadsDir } from "@pd/analyzer";
import { FakeSandbox, loadSandboxConfig, type ExecutionResult, type SandboxDriver, type TestSetup } from "@pd/sandbox";
import { loadLimits, type AnalyzerLimits, type EngineeringJob } from "@pd/shared";
import { buildZip } from "../../analyzer/test/zip-builder";
import { approveExecution, cancelRun, createRun, discardRun, patchPaths, runEngineJob, skipExecution, sweepStaleRuns, type ControlDeps, type EngineDeps } from "../src";
import { fakeDb } from "./fake-db";

// ---------------------------------------------------------------- fixture: a small Node project uploaded as a ZIP

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "shop", scripts: { test: "node tests/run.js" } }) + "\n",
  "src/auth.ts": "export function login(user: string) {\n  return user.length > 0;\n}\n",
  "tests/auth.test.ts": 'import { login } from "../src/auth";\nit("logs in", () => login("a"));\n',
  "README.md": "# Shop\n",
};
const KINDS: Record<string, string> = { "package.json": "CONFIG", "src/auth.ts": "SOURCE", "tests/auth.test.ts": "TEST", "README.md": "DOCUMENTATION" };
const UPLOAD_KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const PLAN: ValidatedPlan = {
  taskSummary: "Reject empty users.",
  interpretation: "Tighten login.",
  assumptions: [],
  affectedFiles: [{ path: "src/auth.ts", change: "modify", reason: "Implements login.", certainty: "VERIFIED", evidence: [], flags: [] }],
  affectedSymbols: [],
  architectureImpact: { statement: "None.", certainty: "INFERRED", evidence: [] },
  implementationSteps: [{ title: "Trim", description: "Trim the user name.", files: ["src/auth.ts"], evidence: [], flags: [] }],
  testPlan: [{ description: "Login test.", path: "tests/auth.test.ts", kind: "existing", evidence: [], flags: [] }],
  configurationChanges: [],
  dependencyChanges: [],
  securityConsiderations: [],
  performanceConsiderations: [],
  risks: [],
  validationPlan: [],
  unknowns: [],
  confidence: 0.8,
};

const edit = (find: string, replace: string): EditOutput => ({
  summary: "Trims the user name.",
  changes: [{ path: "src/auth.ts", operation: "modify", reason: "Trim.", edits: [{ find, replace }], content: null }],
  notes: [],
  confidence: 0.9,
});
const FIRST = edit("return user.length > 0;", "return user.trim().length > 0;");
const SECOND = edit("return user.trim().length > 0;", "return user.trim().length > 1;");

let workspaceDir: string;
let limits: AnalyzerLimits;
let db: ReturnType<typeof fakeDb>;
let jobs: EngineeringJob[];

const silent: any = { child: () => silent, info() {}, warn() {}, error() {}, debug() {} };

beforeEach(async () => {
  workspaceDir = await mkdtemp(path.join(os.tmpdir(), "pd-engine-"));
  limits = loadLimits({ WORKSPACE_DIR: workspaceDir });
  await mkdir(uploadsDir(workspaceDir), { recursive: true });
  await writeFile(uploadPath(workspaceDir, UPLOAD_KEY), buildZip(Object.entries(FILES).map(([name, data]) => ({ name: `shop/${name}`, data, deflate: true }))));
  db = fakeDb({
    userId: "u1",
    repository: { id: "r1", userId: "u1", source: "ZIP", url: null, uploadKey: UPLOAD_KEY },
    analysis: { id: "an1", status: "COMPLETED", commitSha: null, summary: {} },
    task: { id: "t1", userId: "u1", request: "Reject blank user names", constraints: [] },
    plan: { id: "p1", taskId: "t1", status: "COMPLETED", approvedAt: new Date(), plan: PLAN },
    files: Object.entries(FILES).map(([p, text]) => ({ path: p, kind: KINDS[p]!, contentHash: sha(text) })),
  });
  jobs = [];
});
afterEach(() => rm(workspaceDir, { recursive: true, force: true }));

const control = (over: Partial<ControlDeps> = {}): ControlDeps => ({
  prisma: db as any,
  log: silent,
  limits,
  sandbox: { enabled: true, installEnabled: true },
  env: { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key-never-used" },
  enqueue: async (j) => void jobs.push(j),
  ...over,
});
const engine = (provider: ScriptedProvider, sandbox: SandboxDriver, over: Partial<EngineDeps> = {}): EngineDeps => ({
  prisma: db as any,
  log: silent,
  limits,
  sandbox,
  sandboxConfig: loadSandboxConfig({ SANDBOX_ENABLED: sandbox.name === "disabled" ? "false" : "true", SANDBOX_INSTALL_ENABLED: "true" }),
  editProvider: () => provider,
  // The analyzer-based checks are covered in @pd/agent; keep these tests fast.
  check: async () => [],
  ...over,
});
const run = () => db.runs[0]!;
const statuses = () => db.events.filter((e) => e.type === "status").map((e) => e.toStatus);
const startRun = async (input = {}) => (await createRun(control(), "u1", "p1", input)).id as string;

/** Applies the run's patch to the original files with git, as a user would after downloading it. */
async function applyDownloadedPatch(patch: string) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pd-patch-"));
  try {
    for (const [p, text] of Object.entries(FILES)) {
      await mkdir(path.dirname(path.join(dir, p)), { recursive: true });
      await writeFile(path.join(dir, p), text);
    }
    await writeFile(path.join(dir, "change.patch"), patch);
    const r = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "change.patch"], { cwd: dir, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    return await readFile(path.join(dir, "src/auth.ts"), "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- start job

describe("start job", () => {
  it("rebuilds the source, applies validated edits and goes to review when the sandbox is off", async () => {
    const id = await startRun();
    expect(jobs).toEqual([{ type: "run", runId: id, phase: "start" }]);
    const provider = new ScriptedProvider([FIRST]);
    await runEngineJob(id, "start", engine(provider, new FakeSandbox({}, { unavailable: "x" }), { sandboxConfig: loadSandboxConfig({}) }));

    expect(run()).toMatchObject({ status: "READY_FOR_REVIEW", iteration: 1, inputTokens: 100, outputTokens: 50, summary: "Trims the user name.", failureReason: null });
    expect(statuses()).toEqual(["MATERIALIZING", "GENERATING", "VALIDATING", "APPLYING", "READY_FOR_REVIEW"]);
    expect(db.events.at(-1)!.message).toMatch(/Tests not run: Sandboxed test runs are disabled/);
    expect(db.changes).toEqual([expect.objectContaining({ path: "src/auth.ts", operation: "MODIFY", status: "APPLIED", iteration: 1, beforeHash: sha(FILES["src/auth.ts"]!) })]);
    // The model saw the plan's files, redacted context only, and no workspace path.
    const ctx = provider.editCalls[0]!;
    expect(ctx.files.map((f) => f.path)).toEqual(["src/auth.ts", "tests/auth.test.ts"]);
    expect(JSON.stringify(ctx)).not.toContain(workspaceDir);
    // The stored patch is what the user downloads, and it applies to the original source.
    expect(await applyDownloadedPatch(run().patch)).toContain("return user.trim().length > 0;");
    expect(patchPaths(run().patch)).toEqual(["src/auth.ts"]);
    // No workspace outlives the job.
    expect(await readdir(path.join(workspaceDir, "runs"))).toEqual([]);
  });

  it("waits for approval with the resolved, allowlisted test command when the sandbox is on", async () => {
    const id = await startRun();
    await runEngineJob(id, "start", engine(new ScriptedProvider([FIRST]), new FakeSandbox()));
    expect(run().status).toBe("AWAITING_APPROVAL");
    expect(run().testSetup).toMatchObject({ id: "npm", test: { id: "npm-test", display: "npm test" }, install: null });
    expect(run().executionApprovedAt).toBeNull();
  });

  it("repairs output that fails validation, and fails when nothing valid is produced", async () => {
    const id = await startRun({ maxIterations: 2 });
    const provider = new ScriptedProvider([edit("not in the file", "x"), FIRST]);
    await runEngineJob(id, "start", engine(provider, new FakeSandbox({}, { unavailable: "x" })));
    expect(statuses()).toEqual(["MATERIALIZING", "GENERATING", "VALIDATING", "REPAIRING", "VALIDATING", "APPLYING", "READY_FOR_REVIEW"]);
    expect(provider.editCalls[1]!.repair!.problems.join(" ")).toMatch(/does not occur/);
    expect(db.changes.map((c) => [c.iteration, c.status])).toEqual([
      [1, "REJECTED"],
      [2, "APPLIED"],
    ]);

    db.runs.length = 0;
    db.events.length = 0;
    const id2 = await startRun({ maxIterations: 1 });
    await runEngineJob(id2, "start", engine(new ScriptedProvider([edit("nope", "x")]), new FakeSandbox()));
    expect(run()).toMatchObject({ status: "FAILED", failureReason: "no-valid-changes" });
  });

  it("fails cleanly when the provider fails or the model's output is invalid", async () => {
    const id = await startRun();
    await runEngineJob(id, "start", engine(new ScriptedProvider([new ProviderError("refused", "The model declined to make this change.")]), new FakeSandbox()));
    expect(run()).toMatchObject({ status: "FAILED", failureReason: "refused", error: "The model declined to make this change." });
  });

  it("refuses to edit a source that differs from the analysis", async () => {
    // The stored hashes say auth.ts had different content.
    (db as any).file.findMany = async () => Object.entries(FILES).map(([p, text]) => ({ path: p, kind: KINDS[p], contentHash: sha(p === "src/auth.ts" ? "something else" : text) }));
    const id = await startRun();
    const provider = new ScriptedProvider([FIRST]);
    await runEngineJob(id, "start", engine(provider, new FakeSandbox()));
    expect(run()).toMatchObject({ status: "FAILED", failureReason: "source-changed" });
    expect(provider.editCalls).toEqual([]);
  });

  it("stops at the next step when the user cancels", async () => {
    const id = await startRun();
    const provider = new ScriptedProvider([FIRST]);
    const cancelling = { ...provider, name: "scripted", model: "scripted", generatePlan: provider.generatePlan, generateEdits: async (ctx: any) => {
      await cancelRun(control(), "u1", id);
      return provider.generateEdits(ctx);
    } } as any;
    await runEngineJob(id, "start", engine(cancelling, new FakeSandbox()));
    expect(run()).toMatchObject({ status: "CANCELLED" });
    expect(db.events.map((e) => e.type)).toContain("cancel-requested");
    expect(db.changes).toEqual([]);
  });

  it("honours a cancel requested while the changes were applied, instead of waiting for approval", async () => {
    const id = await startRun();
    const fake = new FakeSandbox();
    // The user cancels while the worker is still busy (after generation, before the run is handed over).
    const sandbox: SandboxDriver = { name: "fake", open: (...a) => fake.open(...a), status: async () => (await cancelRun(control(), "u1", id), fake.status()) };
    await runEngineJob(id, "start", engine(new ScriptedProvider([FIRST]), sandbox));
    expect(run().status).toBe("CANCELLED");
    expect(statuses().slice(-2)).toEqual(["APPLYING", "CANCELLED"]);
  });

  it("ignores duplicate or late jobs", async () => {
    const id = await startRun();
    await cancelRun(control(), "u1", id);
    const provider = new ScriptedProvider([FIRST]);
    await runEngineJob(id, "start", engine(provider, new FakeSandbox()));
    expect(run().status).toBe("CANCELLED");
    expect(provider.editCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------- execute job

describe("execute job", () => {
  async function awaiting(provider: ScriptedProvider, sandbox: SandboxDriver, input = {}) {
    const id = await startRun(input);
    await runEngineJob(id, "start", engine(provider, sandbox));
    expect(run().status).toBe("AWAITING_APPROVAL");
    return id;
  }

  it("runs the approved tests on the stored patch and goes to review when they pass", async () => {
    let seen: string | null = null;
    const fake = new FakeSandbox({ test: [{ exitCode: 0, output: "1 passed\n" }] });
    // Check what the sandbox receives: the rebuilt source with the stored patch applied.
    const sandbox: SandboxDriver = { name: "fake", status: () => fake.status(), open: async (r, dir, s) => ((seen = await readFile(path.join(dir, "src/auth.ts"), "utf8")), fake.open(r, dir, s)) };
    const provider = new ScriptedProvider([FIRST]);
    const id = await awaiting(provider, sandbox);
    await approveExecution(control(), "u1", id, { install: false });
    expect(jobs.at(-1)).toEqual({ type: "run", runId: id, phase: "execute" });
    await runEngineJob(id, "execute", engine(provider, sandbox));

    expect(seen).toContain("return user.trim().length > 0;");
    expect(run()).toMatchObject({ status: "READY_FOR_REVIEW", testCommand: "npm-test", installApproved: false });
    expect(db.executions).toEqual([expect.objectContaining({ kind: "TEST", commandId: "npm-test", exitCode: 0, output: "1 passed\n", network: false, iteration: 1 })]);
    expect(fake.calls).toEqual(["test", "close"]);
    expect(statuses().slice(-2)).toEqual(["TESTING", "READY_FOR_REVIEW"]);
  });

  it("repairs failing tests within the budget, re-running install and tests in a fresh sandbox", async () => {
    const fake = new FakeSandbox({ install: { output: "added 0 packages\n" }, test: [{ exitCode: 1, output: "FAIL login\n" }, { exitCode: 0 }] }, { installEnabled: true });
    const provider = new ScriptedProvider([FIRST, SECOND]);
    const id = await awaiting(provider, fake, { maxIterations: 2 });
    // The setup has no install step (no dependencies), so pretend the approved setup had one.
    run().testSetup = { ...(run().testSetup as TestSetup), install: { id: "npm-ci", argv: ["npm", "ci"], display: "npm ci", env: {} } };
    await approveExecution(control(), "u1", id, { install: true });
    await runEngineJob(id, "execute", engine(provider, fake));

    expect(run()).toMatchObject({ status: "READY_FOR_REVIEW", iteration: 2, installApproved: true });
    expect(statuses().slice(-8)).toEqual(["INSTALLING", "TESTING", "REPAIRING", "VALIDATING", "APPLYING", "INSTALLING", "TESTING", "READY_FOR_REVIEW"]);
    expect(fake.calls).toEqual(["install", "test", "close", "install", "test", "close"]);
    expect(db.executions.map((e) => [e.kind, e.iteration, e.exitCode])).toEqual([
      ["INSTALL", 1, 0],
      ["TEST", 1, 1],
      ["INSTALL", 2, 0],
      ["TEST", 2, 0],
    ]);
    // The repair saw the failing output; the cumulative patch holds both edits against the original.
    expect(provider.editCalls[1]!.repair).toMatchObject({ problems: ["The tests failed (exit code 1)."], testOutput: "FAIL login\n" });
    expect(await applyDownloadedPatch(run().patch)).toContain("return user.trim().length > 1;");
  });

  it("stops repairing when the iteration budget is used up", async () => {
    const fake = new FakeSandbox({ test: [{ exitCode: 1 }] });
    const id = await awaiting(new ScriptedProvider([FIRST]), fake, { maxIterations: 1 });
    await approveExecution(control(), "u1", id, { install: false });
    await runEngineJob(id, "execute", engine(new ScriptedProvider([SECOND]), fake));
    expect(run()).toMatchObject({ status: "READY_FOR_REVIEW", iteration: 1 });
    expect(db.events.at(-1)!.message).toMatch(/no repair attempts left/);
  });

  it("does not spend a repair round when the tests lack their dependencies", async () => {
    const fake = new FakeSandbox({ test: [{ exitCode: 127, output: "sh: 1: vitest: not found\n" }] });
    const provider = new ScriptedProvider([FIRST, SECOND]);
    const id = await awaiting(provider, fake, { maxIterations: 2 });
    run().testSetup = { ...(run().testSetup as TestSetup), needsInstall: true };
    await approveExecution(control(), "u1", id, { install: false });
    await runEngineJob(id, "execute", engine(provider, fake));
    expect(run()).toMatchObject({ status: "READY_FOR_REVIEW", iteration: 1 });
    expect(provider.editCalls).toHaveLength(1);
    expect(db.events.at(-1)!.message).toBe("The tests failed (exit code 127). Ready for review (the tests need their dependencies, and the install step was not approved; not repaired).");
  });

  it("never runs tests without the user's approval", async () => {
    const fake = new FakeSandbox({ test: [{ exitCode: 0 }] });
    const id = await awaiting(new ScriptedProvider([FIRST]), fake);
    // A forged execute job while the run waits for approval does nothing.
    await runEngineJob(id, "execute", engine(new ScriptedProvider([FIRST]), fake));
    expect(fake.calls).toEqual([]);
    expect(run().status).toBe("AWAITING_APPROVAL");
  });
});

// ---------------------------------------------------------------- controls

describe("run controls", () => {
  it("require an approved plan, a rebuildable source, an editing model and one open run per plan", async () => {
    db.plans[0]!.approvedAt = null;
    await expect(createRun(control(), "u1", "p1")).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/Approve the plan/) });
    db.plans[0]!.approvedAt = new Date();
    await expect(createRun(control(), "u2", "p1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createRun(control({ env: { AI_PROVIDER: "baseline" } }), "u1", "p1")).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/cannot write code/) });
    await expect(createRun(control(), "u1", "p1", { maxIterations: 9 } as any)).resolves.toBeTruthy(); // budgets are validated by the API schema
    await expect(createRun(control(), "u1", "p1")).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/already has a run/) });
    await rm(uploadPath(workspaceDir, UPLOAD_KEY));
    db.runs[0]!.status = "FAILED";
    await expect(createRun(control(), "u1", "p1")).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/archive .* no longer stored/) });
  });

  it("fails the run when it cannot be queued", async () => {
    await expect(createRun(control({ enqueue: async () => Promise.reject(new Error("redis down")) }), "u1", "p1")).rejects.toThrow("redis down");
    expect(run()).toMatchObject({ status: "FAILED", failureReason: "queue-error" });
  });

  it("gate the install step and let the user skip tests, cancel and discard", async () => {
    const id = await startRun();
    await runEngineJob(id, "start", engine(new ScriptedProvider([FIRST]), new FakeSandbox()));
    await expect(approveExecution(control({ sandbox: { enabled: true, installEnabled: false } }), "u1", id, { install: true })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(approveExecution(control(), "u1", id, { install: true })).rejects.toMatchObject({ message: "This test setup has no install step." });
    await expect(approveExecution(control({ sandbox: { enabled: false, installEnabled: false } }), "u1", id, { install: false })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(approveExecution(control(), "u2", id, { install: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await skipExecution(control(), "u1", id);
    expect(run().status).toBe("READY_FOR_REVIEW");
    await expect(cancelRun(control(), "u1", id)).rejects.toMatchObject({ code: "CONFLICT" });
    await discardRun(control(), "u1", id);
    expect(run()).toMatchObject({ status: "DISCARDED", patch: null });
    expect(db.changes.every((c) => c.diff === null)).toBe(true);
  });

  it("fail runs whose job was lost", async () => {
    const id = await startRun();
    run().status = "GENERATING";
    expect(await sweepStaleRuns(db as any, Date.now())).toBe(0);
    run().updatedAt = new Date(Date.now() - (run().maxDurationSeconds * 1000 + 11 * 60 * 1000));
    expect(await sweepStaleRuns(db as any, Date.now())).toBe(1);
    expect(run()).toMatchObject({ id, status: "FAILED", failureReason: "timeout" });
  });
});
