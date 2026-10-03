import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, ScriptedProvider, type PlanOutput } from "@pd/agent";
import { scanRepository } from "@pd/analyzer";
import { buildRepositoryIndex, createSymbolCollector, type RepositoryIndex } from "@pd/analyzer/intelligence";
import { analyzeCode } from "@pd/analyzer/metrics";

// ------------------------------------------------------------------ mocks: session, database, rate limit, queue, logger

type Row = Record<string, any>;

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com", name: "User One" } as { id: string; email: string; name: string } | null,
  db: null as unknown,
  rateLimited: [] as Array<[string, string]>,
  limitExceeded: false,
  jobs: [] as Array<{ type: string; planId?: string }>,
  logs: [] as Array<{ level: string; obj: unknown; msg?: string }>,
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
vi.mock("@pd/db", () => ({ getPrisma: () => state.db }));
vi.mock("@/server/rate-limit", async () => {
  const { AppError } = await import("@pd/shared");
  return {
    rateLimit: async (policy: string, key: string) => {
      state.rateLimited.push([policy, key]);
      if (state.limitExceeded) throw new AppError("RATE_LIMITED", "Too many requests. Please try again later.");
    },
  };
});
// Planning runs in the worker; the test records queued jobs and runs them in process (settle()).
vi.mock("@/server/queue", () => ({ enqueueEngineering: async (job: { type: string; planId?: string }) => void state.jobs.push(job), enqueueAnalysis: async () => undefined }));
vi.mock("@pd/shared/logger", () => {
  const logger = (): Record<string, unknown> => {
    const l: Record<string, unknown> = {};
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) l[level] = (obj: unknown, msg?: string) => void state.logs.push({ level, obj, msg });
    l.child = () => l;
    return l;
  };
  return { createLogger: logger, rootLogger: logger };
});

const tasksRoute = await import("@/app/api/engineering/tasks/route");
const taskRoute = await import("@/app/api/engineering/tasks/[id]/route");
const planRoute = await import("@/app/api/engineering/tasks/[id]/plan/route");
const approveRoute = await import("@/app/api/engineering/plans/[id]/approve/route");
const { setProviderFactory } = await import("@/server/services/engineering-service");
const { executePlanJob } = await import("@pd/engine/control");
const { createLogger } = await import("@pd/shared/logger");

/** The provider for both sides: the web check at request time and the worker's planner job. */
let workerProvider: (() => any) | null = null;
function useProvider(factory: () => any) {
  setProviderFactory(factory);
  workerProvider = factory;
}
const { clearGraphCache } = await import("@/server/services/intelligence-service");

// ------------------------------------------------------------------ fixture: a real index of a small service

const REPO = {
  "package.json": JSON.stringify({ name: "shop-api", dependencies: { express: "4" }, devDependencies: { vitest: "1" } }),
  "src/routes/auth.ts": `import { Router } from "express";
import { authenticateUser } from "../auth/session";
export const authRouter = Router();
authRouter.post("/login", async (req, res) => {
  res.json(await authenticateUser(req.body.email, req.body.password));
});
`,
  "src/auth/session.ts": "export async function authenticateUser(email: string, password: string) {\n  return { id: email };\n}\n",
  "src/catalog/products.ts": "export function listProducts() {\n  return [];\n}\n",
  "tests/auth.test.ts": 'import { authenticateUser } from "../src/auth/session";\nit("logs in", () => authenticateUser("a", "b"));\n',
};
const ROUTES = [{ method: "POST", path: "/login", file: "src/routes/auth.ts", line: 4, framework: "Express" }];

let root: string;
let index: RepositoryIndex;
let rows: { files: Row[]; deps: Row[]; symbols: Row[] };

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "pd-eng-api-"));
  for (const [rel, text] of Object.entries(REPO)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  const scan = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
  const collector = createSymbolCollector();
  const code = await analyzeCode(scan.files, { onTree: collector.inspectTree });
  index = await buildRepositoryIndex(scan, code, collector.files(), { name: "shop", moduleDepth: 2 });
  const fileId = new Map(scan.files.map((f, i) => [f.path, `f${i}`]));
  rows = {
    files: scan.files.map((f) => ({ id: fileId.get(f.path), analysisId: "an1", path: f.path, kind: f.kind })),
    deps: index.dependencies.map((d) => ({ analysisId: "an1", fromFileId: fileId.get(d.from), toFileId: d.to ? fileId.get(d.to) : null, kind: d.kind, packageName: d.packageName })),
    symbols: index.symbols.map((s, i) => ({ id: `s${i}`, analysisId: "an1", fileId: fileId.get(s.path), name: s.name, kind: s.kind, parent: s.parent, exported: s.exported, line: s.line, endLine: s.endLine, signature: s.signature })),
  };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** In-memory stand-in for the Prisma calls of the analysis, intelligence and engineering services. */
function fakeDb() {
  const ANALYSES: Row[] = [
    { id: "an1", userId: "u1", status: "COMPLETED", repository: { id: "r1", name: "shop", owner: "acme" }, summary: { intelligence: index.summary, practices: { api: { list: ROUTES } } } },
    { id: "old", userId: "u1", status: "COMPLETED", repository: { id: "r1", name: "shop", owner: "acme" }, summary: { codeMetrics: {} } },
    { id: "other", userId: "u2", status: "COMPLETED", repository: { id: "r2", name: "theirs", owner: null }, summary: { intelligence: index.summary } },
  ];
  const FINDINGS: Row[] = [
    { analysisId: "an1", ruleId: "api/login-without-rate-limit", title: "Login endpoint without rate limiting", severity: "HIGH", line: 4, fileId: "src/routes/auth.ts", evidence: "token=sk_live_should_never_leave_the_db", createdAt: new Date(1) },
  ];
  const tasks: Row[] = [];
  const plans: Row[] = [];
  const evidence: Row[] = [];
  let seq = 0;
  const id = (p: string) => `${p}${++seq}`;
  const fileById = (fid: unknown) => rows.files.find((f) => f.id === fid);
  const analysisOf = (aid: unknown) => ANALYSES.find((a) => a.id === aid)!;
  const taskView = (t: Row) => ({ ...t, analysis: { id: t.analysisId, repository: analysisOf(t.analysisId).repository } });
  const pick = (row: Row, select?: Row) => {
    if (!select) return { ...row };
    const out: Row = {};
    for (const k of Object.keys(select)) if (k in row) out[k] = row[k];
    return out;
  };
  const byNewest = (a: Row, b: Row) => b.createdAt - a.createdAt || String(b.id).localeCompare(String(a.id));
  return {
    tasks,
    plans,
    evidence,
    analysis: {
      findFirst: async ({ where }: { where: { id: string; repository: { userId: string } } }) => ANALYSES.find((a) => a.id === where.id && a.userId === where.repository.userId) ?? null,
    },
    file: {
      findFirst: async ({ where }: { where: { analysisId: string; path: { startsWith: string } } }) =>
        rows.files.find((f) => f.analysisId === where.analysisId && f.path.startsWith(where.path.startsWith)) ?? null,
      findMany: async ({ where }: { where: Row }) => rows.files.filter((f) => f.analysisId === where.analysisId),
    },
    fileDependency: {
      findMany: async ({ where }: { where: Row }) =>
        rows.deps.filter((d) => d.analysisId === where.analysisId && d.kind === where.kind && (!where.packageName || d.packageName)).map((d) => ({ ...d, fromFile: fileById(d.fromFileId) })),
    },
    codeSymbol: { findMany: async ({ where }: { where: Row }) => rows.symbols.filter((s) => s.analysisId === where.analysisId) },
    symbolReference: { findMany: async () => [] },
    finding: {
      findMany: async ({ where }: { where: Row }) =>
        FINDINGS.filter((f) => f.analysisId === where.analysisId).map((f) => ({ ruleId: f.ruleId, title: f.title, severity: f.severity, line: f.line, file: { path: f.fileId } })),
    },
    engineeringTask: {
      create: async ({ data }: { data: Row }) => {
        const t = { id: id("t"), createdAt: new Date(Date.now() + seq), ...data };
        tasks.push(t);
        return taskView(t);
      },
      findFirst: async ({ where }: { where: { id: string; userId: string; analysis: { repository: { userId: string } } } }) => {
        const t = tasks.find((x) => x.id === where.id && x.userId === where.userId && analysisOf(x.analysisId).userId === where.analysis.repository.userId);
        return t ? taskView(t) : null;
      },
      findMany: async ({ where }: { where: Row }) =>
        tasks
          .filter((t) => t.analysisId === where.analysisId && t.userId === where.userId)
          .sort(byNewest)
          .map((t) => ({ ...taskView(t), plans: plans.filter((p) => p.taskId === t.id).sort(byNewest).slice(0, 1) })),
    },
    engineeringPlan: {
      create: async ({ data }: { data: Row }) => {
        const p = { id: id("p"), status: "PENDING", approvedAt: null, plan: null, validation: null, validationStatus: null, confidence: null, failureReason: null, error: null, finishedAt: null, createdAt: new Date(Date.now() + seq), ...data };
        plans.push(p);
        return { ...p };
      },
      findFirst: async ({ where }: { where: Row }) => {
        if (where.id) {
          // Ownership lookup by plan id: the task's owner and the analysis's repository owner must both match.
          const p = plans.find((x) => x.id === where.id);
          const t = p && tasks.find((x) => x.id === p.taskId);
          const owned = t && t.userId === where.task.userId && analysisOf(t.analysisId).userId === where.task.analysis.repository.userId;
          return owned ? { ...p } : null;
        }
        const p = plans.filter((x) => x.taskId === where.taskId).sort(byNewest)[0];
        return p ? { ...p } : null;
      },
      update: async ({ where, data, select }: { where: Row; data: Row; select?: Row }) => {
        const p = plans.find((x) => x.id === where.id);
        if (!p) throw new Error("not found");
        for (const [k, v] of Object.entries(data)) if (v !== undefined) p[k] = v;
        const task = tasks.find((t) => t.id === p.taskId)!;
        return select?.task ? { id: p.id, task } : pick(p, select);
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hits = plans.filter(
          (x) => x.id === where.id && (where.status.in ? where.status.in.includes(x.status) : x.status === where.status) && (!("approvedAt" in where) || x.approvedAt == where.approvedAt),
        );
        for (const p of hits) Object.assign(p, data);
        return { count: hits.length };
      },
      findUniqueOrThrow: async ({ where, select }: { where: Row; select?: Row }) => {
        const p = plans.find((x) => x.id === where.id)!;
        if (select?.task) return { id: p.id, task: tasks.find((t) => t.id === p.taskId)! };
        return { ...p, evidence: evidence.filter((e) => e.planId === p.id) };
      },
    },
    engineeringPlanEvidence: {
      createMany: async ({ data }: { data: Row[] }) => {
        evidence.push(...data.map((d) => ({ id: id("e"), ...d })));
        return { count: data.length };
      },
    },
  };
}

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  db = fakeDb();
  state.db = db;
  state.user = { id: "u1", email: "u1@example.com", name: "User One" };
  state.rateLimited = [];
  state.limitExceeded = false;
  state.jobs = [];
  workerProvider = null;
  state.logs = [];
  clearGraphCache();
  setProviderFactory(null);
});

const ORIGIN = "http://localhost:3000";
const JSON_HEADERS = { origin: ORIGIN, "content-type": "application/json" };
type Body = { data?: any; error?: { code: string; message: string; details?: unknown } };
type Handler = (req: NextRequest, ctx: { params: Promise<any> }) => Promise<Response>;
const call = async (handler: Handler, url: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; id?: string } = {}) => {
  const req = new NextRequest(`${ORIGIN}${url}`, {
    method: init.method ?? "GET",
    headers: init.headers ?? (init.method === "POST" ? JSON_HEADERS : {}),
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
  const res = await handler(req, { params: Promise.resolve({ id: init.id ?? "" }) });
  return { status: res.status, body: (await res.json()) as Body };
};
const createTask = (body: unknown, headers?: Record<string, string>) => call(tasksRoute.POST, "/api/engineering/tasks", { method: "POST", body, headers });
const requestPlan = (id: string, headers?: Record<string, string>) => call(planRoute.POST, `/api/engineering/tasks/${id}/plan`, { method: "POST", id, headers });
const getPlan = (id: string) => call(planRoute.GET, `/api/engineering/tasks/${id}/plan`, { id });
const getTask = (id: string) => call(taskRoute.GET, `/api/engineering/tasks/${id}`, { id });
const approvePlan = (id: string, headers?: Record<string, string>) => call(approveRoute.POST, `/api/engineering/plans/${id}/approve`, { method: "POST", id, headers });
/** Runs the queued plan jobs as the worker would, then forgets them. */
async function settle() {
  const jobs = state.jobs.splice(0);
  for (const j of jobs) {
    if (j.type === "plan") await executePlanJob(j.planId!, { prisma: state.db as any, log: createLogger("planner"), provider: () => workerProvider!() });
  }
}

const TASK = { analysisId: "an1", task: "Add rate limiting to the login endpoint" };

/** A plan citing the evidence the service will have built for TASK, plus whatever `mutate` adds. */
function scriptedPlan(mutate: (p: PlanOutput, ref: (pred: (e: any) => boolean) => string) => void = () => {}) {
  return {
        generatePlan: async (ctx: any) => {
          const ref = (pred: (e: any) => boolean) => ctx.evidence.find(pred).id as string;
          const route = ref((e) => e.kind === "ROUTE");
          const plan: PlanOutput = {
            taskSummary: "Limit login attempts.",
            interpretation: "Throttle POST /login.",
            assumptions: [],
            affectedFiles: [{ path: "src/routes/auth.ts", change: "modify", reason: "Declares POST /login.", certainty: "VERIFIED", evidence: [route] }],
            affectedSymbols: [{ name: "authenticateUser", path: "src/auth/session.ts", change: "review", reason: "Called by the route.", certainty: "INFERRED", evidence: [route] }],
            architectureImpact: { statement: "Adds a middleware.", certainty: "INFERRED", evidence: [route] },
            implementationSteps: [{ title: "Add limiter", description: "Apply a limiter to the login route.", files: ["src/routes/auth.ts"], evidence: [route] }],
            testPlan: [{ description: "Login still works.", path: "tests/auth.test.ts", kind: "existing", evidence: [ref((e) => e.kind === "TEST")] }],
            configurationChanges: [],
            dependencyChanges: [],
            securityConsiderations: [],
            performanceConsiderations: [],
            risks: [],
            validationPlan: ["Run the API tests and confirm the login tests pass."],
            unknowns: [],
            confidence: 0.9,
          };
          mutate(plan, ref);
          return { output: plan, model: "claude-test", inputTokens: 1000, outputTokens: 400, stopReason: "end_turn" };
        },
        name: "anthropic",
        model: "claude-test",
      };
}

async function taskId(body: unknown = TASK) {
  const r = await createTask(body);
  expect(r.status).toBe(201);
  return r.body.data.id as string;
}

describe("POST /api/engineering/tasks", () => {
  it("creates a task for an owned, indexed analysis without planning or executing anything", async () => {
    const r = await createTask({ ...TASK, scope: "src/", constraints: ["Keep the public API unchanged"] });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ analysisId: "an1", request: TASK.task, scope: "src", constraints: ["Keep the public API unchanged"], analysis: { repository: { name: "shop" } } });
    expect(db.plans).toEqual([]);
    expect(state.rateLimited).toEqual([["ai", "u1"]]);
  });

  it("requires authentication and a same-origin request", async () => {
    state.user = null;
    expect((await createTask(TASK)).status).toBe(401);
    state.user = { id: "u1", email: "", name: "" };
    expect((await createTask(TASK, { "content-type": "application/json" })).status).toBe(403);
    expect((await createTask(TASK, { origin: "https://evil.example", "content-type": "application/json" })).status).toBe(403);
  });

  it("returns 404 for analyses the user does not own, and 409 for analyses without an index", async () => {
    expect((await createTask({ ...TASK, analysisId: "other" })).status).toBe(404);
    expect((await createTask({ ...TASK, analysisId: "missing" })).status).toBe(404);
    const old = await createTask({ ...TASK, analysisId: "old" });
    expect(old.status).toBe(409);
    expect(old.body.error!.message).toMatch(/no repository index/);
  });

  it("validates task length, scope, constraints and malformed input", async () => {
    const bad = async (body: unknown) => (await createTask(body)).status;
    expect(await bad({ ...TASK, task: "too short" })).toBe(400);
    expect(await bad({ ...TASK, task: "x".repeat(2001) })).toBe(400);
    expect(await bad({ ...TASK, task: "Add rate limiting\u0007 to login" })).toBe(400);
    expect(await bad({ ...TASK, scope: "../etc" })).toBe(400);
    expect(await bad({ ...TASK, scope: "/abs/path" })).toBe(400);
    expect(await bad({ ...TASK, scope: "src/nowhere" })).toBe(400);
    expect(await bad({ ...TASK, constraints: Array(11).fill("c") })).toBe(400);
    expect(await bad({ ...TASK, analysisId: "bad id!" })).toBe(400);
    expect(await bad({ ...TASK, extra: true })).toBe(400);
    expect(await bad("{not json")).toBe(400);
    expect(db.tasks).toEqual([]);
  });

  it("is rate limited", async () => {
    state.limitExceeded = true;
    expect((await createTask(TASK)).status).toBe(429);
  });
});

describe("planning", () => {
  it("runs context retrieval, the provider and validation, and stores plan, evidence and metadata", async () => {
    const provider = scriptedPlan();
    const calls: any[] = [];
    useProvider(() => ({ ...provider, generatePlan: (ctx: any) => (calls.push(ctx), provider.generatePlan(ctx)) }));
    const id = await taskId();
    const started = await requestPlan(id);
    expect(started.status).toBe(202);
    expect(started.body.data).toMatchObject({ status: "PENDING", provider: "anthropic", model: "claude-test", inProgress: true });
    await settle();

    // The provider saw only the bounded evidence bundle, built from the Phase 6 index.
    const ctx = calls[0];
    expect(ctx.task).toEqual({ request: TASK.task, scope: null, constraints: [] });
    expect(ctx.evidence.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["MANIFEST", "FILE", "ROUTE", "IMPORT", "TEST", "CONFIG", "PACKAGE", "FINDING"]));
    expect(JSON.stringify(ctx)).not.toContain("sk_live_should_never_leave_the_db");
    expect(JSON.stringify(ctx)).not.toContain("res.json(");

    const plan = await getPlan(id);
    expect(plan.status).toBe(200);
    expect(plan.body.data).toMatchObject({
      status: "COMPLETED",
      inProgress: false,
      model: "claude-test",
      validationStatus: "PASSED",
      confidence: 0.9,
      inputTokens: 1000,
      outputTokens: 400,
      validation: { status: "PASSED", issues: [] },
      plan: { affectedFiles: [{ path: "src/routes/auth.ts", certainty: "VERIFIED", flags: [] }] },
    });
    expect(plan.body.data.evidence.map((e: any) => e.ref)).toEqual(ctx.evidence.map((e: any) => e.id));
    expect(plan.body.data.contextStats.evidence).toBe(ctx.evidence.length);
    const task = await getTask(id);
    expect(task.body.data).toMatchObject({ id, latestPlan: { status: "COMPLETED", validationStatus: "PASSED" } });

    // Observability: provider, model, duration, tokens, validation; never the task, plan text or keys.
    const entry = state.logs.find((l) => l.msg === "plan generated")!;
    expect(entry.obj).toMatchObject({ provider: "anthropic", model: "claude-test", inputTokens: 1000, outputTokens: 400, validation: "PASSED", errors: 0, failureReason: null });
    expect(JSON.stringify(state.logs)).not.toMatch(/rate limiting to the login|Throttle POST/);
  });

  it("flags hallucinated files and symbols, removes commands and redacts secrets before storing", async () => {
    // A fake key in Stripe's live-key format, assembled at runtime so secret scanners do not flag the test source.
    const fakeKey = ["sk", "live", "51HaBcDeFgHiJkLmNoPqRsTuV"].join("_");
    useProvider(() =>
      scriptedPlan((p, ref) => {
        p.affectedFiles.push({ path: "src/auth/login-controller.ts", change: "modify", reason: "Login controller.", certainty: "VERIFIED", evidence: [ref((e) => e.kind === "FILE")] });
        p.affectedSymbols.push({ name: "rateLimitLogin", path: "src/routes/auth.ts", change: "modify", reason: "Existing limiter.", certainty: "VERIFIED", evidence: ["E1"] });
        p.validationPlan.push("npm install express-rate-limit");
        p.risks.push({ description: `Leaks api_key = ${fakeKey}`, severity: "HIGH", mitigation: "Rotate.", evidence: [] });
      }),
    );
    const id = await taskId();
    await requestPlan(id);
    await settle();
    const { data } = (await getPlan(id)).body;
    expect(data).toMatchObject({ status: "COMPLETED", validationStatus: "ERRORS" });
    expect(data.validation.issues.map((i: any) => i.code).sort()).toEqual(["command", "nonexistent-file", "nonexistent-symbol", "secret"]);
    expect(data.plan.affectedFiles[1]).toMatchObject({ path: "src/auth/login-controller.ts", certainty: "UNKNOWN", flags: ["nonexistent-file"] });
    expect(data.plan.affectedSymbols[1]).toMatchObject({ name: "rateLimitLogin", certainty: "UNKNOWN", flags: ["nonexistent-symbol"] });
    expect(JSON.stringify(db.plans)).not.toContain(fakeKey);
    expect(JSON.stringify(db.plans)).not.toContain("npm install");
    expect(data.confidence).toBeLessThan(0.9);
  });

  it("stores a failed plan when the output does not match the schema or the provider fails", async () => {
    useProvider(() => new ScriptedProvider([{ plan: "Just edit the files." }]));
    const id = await taskId();
    await requestPlan(id);
    await settle();
    expect((await getPlan(id)).body.data).toMatchObject({ status: "FAILED", failureReason: "invalid-output", validationStatus: "REJECTED", plan: null, inProgress: false });

    useProvider(() => new ScriptedProvider([new ProviderError("refused", "The model declined to plan this task.")]));
    await requestPlan(id);
    await settle();
    expect((await getPlan(id)).body.data).toMatchObject({ status: "FAILED", failureReason: "refused", error: "The model declined to plan this task." });
    expect(state.logs.filter((l) => l.msg === "plan failed").map((l) => (l.obj as Row).failureReason)).toEqual(["invalid-output", "refused"]);
  });

  it("queues planning for the worker instead of running it in the web process", async () => {
    const provider = scriptedPlan();
    let generated = 0;
    useProvider(() => ({ ...provider, generatePlan: (ctx: any) => (generated++, provider.generatePlan(ctx)) }));
    const id = await taskId();
    const started = await requestPlan(id);
    expect(started.status).toBe(202);
    expect(state.jobs).toEqual([{ type: "plan", planId: started.body.data.id }]);
    expect(generated).toBe(0);
    expect((await getPlan(id)).body.data).toMatchObject({ status: "PENDING", inProgress: true });
    await settle();
    expect(generated).toBe(1);
    expect((await getPlan(id)).body.data.status).toBe("COMPLETED");
  });

  it("refuses to plan when no provider is configured, without storing a plan", async () => {
    useProvider(() => {
      throw new ProviderError("not-configured", "No AI provider is configured: set ANTHROPIC_API_KEY, or AI_PROVIDER=baseline for evidence-only plans.");
    });
    const id = await taskId();
    const r = await requestPlan(id);
    expect(r.status).toBe(409);
    expect(r.body.error!.message).toMatch(/No AI provider is configured/);
    expect(db.plans).toEqual([]);
  });

  it("allows one plan at a time per task and expires lost runs", async () => {
    // The provider waits until released, so the first plan stays RUNNING.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const provider = scriptedPlan();
    useProvider(() => ({ ...provider, generatePlan: async (ctx: any) => (await gate, provider.generatePlan(ctx)) }));
    const id = await taskId();
    await requestPlan(id);
    expect((await requestPlan(id)).status).toBe(409);
    release();
    await settle();
    expect(db.plans.map((p) => p.status)).toEqual(["COMPLETED"]);
    db.plans[0]!.status = "RUNNING";
    db.plans[0]!.createdAt = new Date(Date.now() - 16 * 60 * 1000);
    expect((await getTask(id)).body.data.latestPlan).toMatchObject({ status: "FAILED", failureReason: "timeout" });
    expect((await requestPlan(id)).status).toBe(202);
  });

  it("enforces ownership on every task endpoint and requires auth and Origin", async () => {
    useProvider(() => scriptedPlan());
    const id = await taskId();
    state.user = { id: "u2", email: "", name: "" };
    expect((await getTask(id)).status).toBe(404);
    expect((await getPlan(id)).status).toBe(404);
    expect((await requestPlan(id)).status).toBe(404);
    expect((await call(tasksRoute.GET, "/api/engineering/tasks?analysisId=an1")).status).toBe(404);
    state.user = null;
    expect((await getPlan(id)).status).toBe(401);
    expect((await requestPlan(id)).status).toBe(401);
    state.user = { id: "u1", email: "", name: "" };
    expect((await requestPlan(id, { origin: "https://evil.example" })).status).toBe(403);
    expect((await getTask("bad id!")).status).toBe(400);
    expect(db.plans).toEqual([]);
  });

  it("lists the user's tasks for an analysis with their latest plan, and returns null before any plan", async () => {
    useProvider(() => scriptedPlan());
    const first = await taskId();
    const second = await taskId({ ...TASK, task: "Add pagination to listProducts" });
    expect((await getPlan(second)).body.data).toBeNull();
    await requestPlan(first);
    await settle();
    const list = await call(tasksRoute.GET, "/api/engineering/tasks?analysisId=an1");
    expect(list.body.data.map((t: any) => [t.id, t.latestPlan?.status ?? null])).toEqual([
      [second, null],
      [first, "COMPLETED"],
    ]);
    expect((await call(tasksRoute.GET, "/api/engineering/tasks")).status).toBe(400);
  });
});

describe("POST /api/engineering/plans/:id/approve (code engine, first gate)", () => {
  async function completedPlan() {
    useProvider(() => scriptedPlan());
    const task = await taskId();
    const started = await requestPlan(task);
    await settle();
    return { task, plan: started.body.data.id as string };
  }

  it("approves the task's latest completed plan once, without generating or running anything", async () => {
    const { task, plan } = await completedPlan();
    expect((await getPlan(task)).body.data.approvedAt).toBeNull();
    const r = await approvePlan(plan);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: plan });
    const approvedAt = r.body.data.approvedAt;
    expect(new Date(approvedAt).getTime()).not.toBeNaN();
    // The planner API shows the approval.
    expect((await getPlan(task)).body.data.approvedAt).toBe(approvedAt);
    expect((await getTask(task)).body.data.latestPlan.approvedAt).toBe(approvedAt);
    // Idempotent: approving again keeps the first time.
    expect((await approvePlan(plan)).body.data.approvedAt).toBe(approvedAt);
    expect(state.logs.filter((l) => l.msg === "plan approved")).toHaveLength(1);
    expect(JSON.stringify(state.logs)).not.toMatch(/rate limiting to the login|Throttle POST/);
  });

  it("refuses plans that did not complete, are in progress or were superseded", async () => {
    useProvider(() => new ScriptedProvider([{ plan: "Just edit the files." }]));
    const task = await taskId();
    const failed = (await requestPlan(task)).body.data.id;
    await settle();
    const r = await approvePlan(failed);
    expect(r.status).toBe(409);
    expect(r.body.error!.message).toMatch(/Only a completed plan/);

    // In progress.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const provider = scriptedPlan();
    useProvider(() => ({ ...provider, generatePlan: async (ctx: any) => (await gate, provider.generatePlan(ctx)) }));
    const running = (await requestPlan(task)).body.data.id;
    expect((await approvePlan(running)).status).toBe(409);
    release();
    await settle();
    expect((await approvePlan(running)).status).toBe(200);

    // A newer plan supersedes an older, unapproved one.
    const { task: t2, plan: older } = await completedPlan();
    await requestPlan(t2);
    await settle();
    const superseded = await approvePlan(older);
    expect(superseded.status).toBe(409);
    expect(superseded.body.error!.message).toMatch(/newer plan/);
    expect(db.plans.find((p) => p.id === older)!.approvedAt).toBeNull();
  });

  it("enforces authentication, ownership and the Origin check", async () => {
    const { plan } = await completedPlan();
    state.user = { id: "u2", email: "", name: "" };
    expect((await approvePlan(plan)).status).toBe(404);
    expect((await approvePlan("missing")).status).toBe(404);
    state.user = null;
    expect((await approvePlan(plan)).status).toBe(401);
    state.user = { id: "u1", email: "", name: "" };
    expect((await approvePlan(plan, { "content-type": "application/json" })).status).toBe(403);
    expect((await approvePlan(plan, { origin: "https://evil.example" })).status).toBe(403);
    expect((await approvePlan("bad id!")).status).toBe(400);
    expect(db.plans.find((p) => p.id === plan)!.approvedAt).toBeNull();
  });
});
