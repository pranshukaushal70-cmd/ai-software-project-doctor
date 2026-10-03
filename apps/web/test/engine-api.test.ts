import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptedProvider, type EditOutput, type ValidatedPlan } from "@pd/agent";
import { uploadPath, uploadsDir } from "@pd/analyzer";
import { FakeSandbox, loadSandboxConfig } from "@pd/sandbox";
import { buildZip } from "../../../packages/analyzer/test/zip-builder";
import { fakeDb } from "../../../packages/engine/test/fake-db";

// ------------------------------------------------------------------ mocks: session, database, rate limit, queue

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com", name: "User One" } as { id: string; email: string; name: string } | null,
  db: null as unknown,
  jobs: [] as Array<{ type: string; runId?: string; phase?: "start" | "execute" }>,
  rateLimited: [] as Array<[string, string]>,
  limitExceeded: false,
}));

vi.mock("@/server/auth/session", async () => {
  const { AppError } = await import("@pd/shared");
  return {
    requireApiUser: async () => {
      if (!state.user) throw new AppError("UNAUTHENTICATED", "Please sign in");
      return state.user;
    },
  };
});
vi.mock("@pd/db", async (orig) => ({ ...(await orig<typeof import("@pd/db")>()), getPrisma: () => state.db }));
vi.mock("@/server/rate-limit", async () => {
  const { AppError } = await import("@pd/shared");
  return {
    rateLimit: async (policy: string, key: string) => {
      state.rateLimited.push([policy, key]);
      if (state.limitExceeded) throw new AppError("RATE_LIMITED", "Too many requests. Please try again later.");
    },
  };
});
vi.mock("@/server/queue", () => ({ enqueueEngineering: async (job: (typeof state.jobs)[number]) => void state.jobs.push(job), enqueueAnalysis: async () => undefined }));

const runsRoute = await import("@/app/api/engineering/plans/[id]/runs/route");
const runRoute = await import("@/app/api/engineering/runs/[id]/route");
const executeRoute = await import("@/app/api/engineering/runs/[id]/execute/route");
const skipRoute = await import("@/app/api/engineering/runs/[id]/skip-tests/route");
const cancelRoute = await import("@/app/api/engineering/runs/[id]/cancel/route");
const discardRoute = await import("@/app/api/engineering/runs/[id]/discard/route");
const patchRoute = await import("@/app/api/engineering/runs/[id]/patch/route");
const { runEngineJob } = await import("@pd/engine");

// ------------------------------------------------------------------ fixture: an approved plan for an uploaded project

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "shop", scripts: { test: "node tests/run.js" } }) + "\n",
  "src/auth.ts": "export function login(user: string) {\n  return user.length > 0;\n}\n",
  "tests/auth.test.ts": 'import { login } from "../src/auth";\nit("logs in", () => login("a"));\n',
};
const KINDS: Record<string, string> = { "package.json": "CONFIG", "src/auth.ts": "SOURCE", "tests/auth.test.ts": "TEST" };
const UPLOAD_KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const PLAN: ValidatedPlan = {
  taskSummary: "Reject blank users.",
  interpretation: "Trim the user name.",
  assumptions: [],
  affectedFiles: [{ path: "src/auth.ts", change: "modify", reason: "Implements login.", certainty: "VERIFIED", evidence: [], flags: [] }],
  affectedSymbols: [],
  architectureImpact: { statement: "None.", certainty: "INFERRED", evidence: [] },
  implementationSteps: [],
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
const EDIT: EditOutput = {
  summary: "Trims the user name.",
  changes: [{ path: "src/auth.ts", operation: "modify", reason: "Trim.", edits: [{ find: "return user.length > 0;", replace: "return user.trim().length > 0;" }], content: null }],
  notes: ["Check callers that pass padded names."],
  confidence: 0.9,
};

let workspaceDir: string;
const ENV_KEYS = ["WORKSPACE_DIR", "SANDBOX_ENABLED", "SANDBOX_INSTALL_ENABLED", "AI_PROVIDER", "ANTHROPIC_API_KEY"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

beforeEach(async () => {
  workspaceDir = await mkdtemp(path.join(os.tmpdir(), "pd-engine-api-"));
  Object.assign(process.env, { WORKSPACE_DIR: workspaceDir, SANDBOX_ENABLED: "true", SANDBOX_INSTALL_ENABLED: "false", AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key-never-used" });
  await mkdir(uploadsDir(workspaceDir), { recursive: true });
  await writeFile(uploadPath(workspaceDir, UPLOAD_KEY), buildZip(Object.entries(FILES).map(([name, data]) => ({ name: `shop/${name}`, data, deflate: true }))));
  state.db = fakeDb({
    userId: "u1",
    repository: { id: "r1", userId: "u1", source: "ZIP", url: null, uploadKey: UPLOAD_KEY },
    analysis: { id: "an1", status: "COMPLETED", commitSha: null, summary: {} },
    task: { id: "t1", userId: "u1", request: "Reject blank user names", constraints: [] },
    plan: { id: "p1", taskId: "t1", status: "COMPLETED", approvedAt: new Date(), plan: PLAN },
    files: Object.entries(FILES).map(([p, text]) => ({ path: p, kind: KINDS[p]!, contentHash: sha(text) })),
  });
  state.user = { id: "u1", email: "u1@example.com", name: "User One" };
  state.jobs = [];
  state.rateLimited = [];
  state.limitExceeded = false;
});
afterEach(() => rm(workspaceDir, { recursive: true, force: true }));

// ------------------------------------------------------------------ helpers

const ORIGIN = "http://localhost:3000";
type Handler = (req: NextRequest, ctx: { params: Promise<any> }) => Promise<Response>;
async function call(handler: Handler, url: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; id: string }) {
  const post = init.method === "POST";
  const req = new NextRequest(`${ORIGIN}${url}`, {
    method: init.method ?? "GET",
    headers: init.headers ?? (post ? { origin: ORIGIN, "content-type": "application/json" } : {}),
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
  return handler(req, { params: Promise.resolve({ id: init.id }) });
}
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as { data?: any; error?: { code: string; message: string } } });
const start = async (body?: unknown, headers?: Record<string, string>) => json(await call(runsRoute.POST, "/api/engineering/plans/p1/runs", { method: "POST", id: "p1", body, headers }));
const detail = async (id: string) => json(await call(runRoute.GET, `/api/engineering/runs/${id}`, { id }));
const post = async (handler: Handler, id: string, action: string, body?: unknown, headers?: Record<string, string>) => json(await call(handler, `/api/engineering/runs/${id}/${action}`, { method: "POST", id, body, headers }));
const patch = (id: string) => call(patchRoute.GET, `/api/engineering/runs/${id}/patch`, { id });

/** Runs the queued worker jobs in process, as the worker would. */
async function work(provider: ScriptedProvider, sandbox = new FakeSandbox({ test: [{ exitCode: 0, output: "1 passed\n" }] })) {
  for (const job of state.jobs.splice(0)) {
    if (job.type !== "run") continue;
    const silent: any = { child: () => silent, info() {}, warn() {}, error() {}, debug() {} };
    await runEngineJob(job.runId!, job.phase!, {
      prisma: state.db as any,
      log: silent,
      limits: { ...(await import("@pd/shared")).loadLimits() },
      sandbox,
      sandboxConfig: loadSandboxConfig(),
      editProvider: () => provider,
      check: async () => [],
    });
  }
  return sandbox;
}

// ------------------------------------------------------------------ the flow

describe("code engine API", () => {
  it("runs the whole flow: start, review the proposal, approve the tests, download the patch, discard", async () => {
    const started = await start();
    expect(started.status).toBe(201);
    const id = started.body.data.id as string;
    expect(started.body.data).toMatchObject({ status: "QUEUED", inProgress: true, provider: "anthropic", hasPatch: false, sandbox: { enabled: true, installEnabled: false } });
    expect(state.rateLimited).toEqual([["engine", "u1"]]);
    expect(state.jobs).toEqual([{ type: "run", runId: id, phase: "start" }]);

    // The worker proposes and applies the change, then waits for approval.
    const provider = new ScriptedProvider([EDIT]);
    await work(provider);
    let r = await detail(id);
    expect(r.body.data).toMatchObject({
      status: "AWAITING_APPROVAL",
      inProgress: false,
      summary: "Trims the user name.",
      notes: ["Check callers that pass padded names."],
      hasPatch: true,
      testSetup: { id: "npm", test: { id: "npm-test", command: "npm test" }, install: null },
    });
    // The setup shown to the browser has command lines, not the container environment.
    expect(JSON.stringify(r.body.data.testSetup)).not.toContain("npm_config");
    expect(r.body.data.changes).toEqual([expect.objectContaining({ path: "src/auth.ts", operation: "MODIFY", status: "APPLIED", additions: 1, deletions: 1, diff: expect.stringContaining("+  return user.trim().length > 0;") })]);
    expect(r.body.data.events.map((e: any) => e.toStatus)).toEqual(["QUEUED", "MATERIALIZING", "GENERATING", "VALIDATING", "APPLYING", "AWAITING_APPROVAL"]);
    // No patch download before review.
    expect((await json(await patch(id))).status).toBe(409);

    // Second gate.
    const approved = await post(executeRoute.POST, id, "execute", { install: false });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ status: "TESTING", installApproved: false, testCommand: "npm-test" });
    const sandbox = await work(provider);
    expect(sandbox.calls).toEqual(["test", "close"]);
    r = await detail(id);
    expect(r.body.data).toMatchObject({ status: "READY_FOR_REVIEW", executions: [expect.objectContaining({ kind: "TEST", exitCode: 0, output: "1 passed\n", network: false })] });

    // Download: an attachment that applies to the original source.
    const res = await patch(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/x-diff; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="code-engine-${id}.patch"`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const text = await res.text();
    const dir = await mkdtemp(path.join(os.tmpdir(), "pd-download-"));
    try {
      for (const [p, content] of Object.entries(FILES)) {
        await mkdir(path.dirname(path.join(dir, p)), { recursive: true });
        await writeFile(path.join(dir, p), content);
      }
      await writeFile(path.join(dir, "change.patch"), text);
      expect(spawnSync("git", ["apply", "change.patch"], { cwd: dir }).status).toBe(0);
      expect(await readFile(path.join(dir, "src/auth.ts"), "utf8")).toContain("user.trim()");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // Discard deletes the stored code.
    const discarded = await post(discardRoute.POST, id, "discard");
    expect(discarded.body.data).toMatchObject({ status: "DISCARDED", hasPatch: false, changes: [expect.objectContaining({ diff: null })] });
    expect((await json(await patch(id))).status).toBe(409);
  });

  it("lets the user skip the tests or cancel a waiting run", async () => {
    const id = (await start()).body.data.id;
    await work(new ScriptedProvider([EDIT]));
    expect((await post(skipRoute.POST, id, "skip-tests")).body.data).toMatchObject({ status: "READY_FOR_REVIEW", executions: [] });
    expect((await post(cancelRoute.POST, id, "cancel")).status).toBe(409);

    (state.db as any).runs[0].status = "FAILED"; // let a second run start
    const second = (await start()).body.data.id;
    expect((await post(cancelRoute.POST, second, "cancel")).body.data).toMatchObject({ status: "CANCELLED" });
  });

  it("validates input, and refuses the install step when the server disables it", async () => {
    expect((await start({ maxIterations: 9 })).status).toBe(400);
    expect((await start({ unknown: true })).status).toBe(400);
    expect((await start("{not json")).status).toBe(400);
    const id = (await start({ maxIterations: 2, tokenBudget: 50_000 })).body.data.id;
    expect((await detail(id)).body.data).toMatchObject({ maxIterations: 2, tokenBudget: 50_000 });
    await work(new ScriptedProvider([EDIT]));
    expect((await post(executeRoute.POST, id, "execute", { install: "yes" })).status).toBe(400);
    const refused = await post(executeRoute.POST, id, "execute", { install: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error!.message).toMatch(/install step is disabled/);
  });

  it("enforces authentication, ownership, the Origin check and the rate limit on every endpoint", async () => {
    const id = (await start()).body.data.id;
    state.user = { id: "u2", email: "", name: "" };
    expect((await start()).status).toBe(404);
    expect((await detail(id)).status).toBe(404);
    expect((await json(await call(runsRoute.GET, "/api/engineering/plans/p1/runs", { id: "p1" }))).status).toBe(404);
    for (const [h, a] of [
      [executeRoute.POST, "execute"],
      [skipRoute.POST, "skip-tests"],
      [cancelRoute.POST, "cancel"],
      [discardRoute.POST, "discard"],
    ] as const) {
      expect((await post(h, id, a, a === "execute" ? { install: false } : undefined)).status).toBe(404);
    }
    expect((await json(await patch(id))).status).toBe(404);
    state.user = null;
    expect((await detail(id)).status).toBe(401);
    expect((await start()).status).toBe(401);
    state.user = { id: "u1", email: "", name: "" };
    expect((await start(undefined, { "content-type": "application/json" })).status).toBe(403);
    expect((await post(cancelRoute.POST, id, "cancel", undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect((await detail("bad id!")).status).toBe(400);
    state.limitExceeded = true;
    (state.db as any).runs[0].status = "FAILED";
    expect((await start()).status).toBe(429);
    // Nothing above changed the run.
    expect((state.db as any).runs).toHaveLength(1);
  });

  it("lists a plan's runs and reports when no model can write code", async () => {
    const id = (await start()).body.data.id;
    const list = await json(await call(runsRoute.GET, "/api/engineering/plans/p1/runs", { id: "p1" }));
    expect(list.body.data).toEqual([expect.objectContaining({ id, status: "QUEUED", inProgress: true })]);
    (state.db as any).runs[0].status = "FAILED";
    process.env.AI_PROVIDER = "baseline";
    const refused = await start();
    expect(refused.status).toBe(409);
    expect(refused.body.error!.message).toMatch(/cannot write code/);
  });
});
