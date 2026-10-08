import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Session } from "./client";
import { AUTH_DIR, STUB_URL } from "./env";
import { zipDirectory } from "./zip";

/** Shared steps of the end-to-end specs: users, analyses, plans and runs, with polling. */

export interface StoredUser {
  id: string;
  email: string;
  password: string;
  cookie: string;
}

/** The users global setup created: `owner` owns everything the specs create, `intruder` checks isolation. */
export function users(): { owner: Session; intruder: Session; ownerUser: StoredUser } {
  const stored = JSON.parse(readFileSync(new URL("users.json", AUTH_DIR), "utf8")) as Record<"owner" | "intruder", StoredUser>;
  return {
    owner: new Session(stored.owner.cookie, stored.owner),
    intruder: new Session(stored.intruder.cookie, stored.intruder),
    ownerUser: stored.owner,
  };
}

export async function poll<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 120_000, intervalMs = 750): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T = await read();
  while (!done(last)) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}; last value: ${JSON.stringify(last).slice(0, 600)}`);
    await new Promise((r) => setTimeout(r, intervalMs));
    last = await read();
  }
  return last;
}

export interface AnalysisDto {
  id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  stage: string;
  error: string | null;
  healthScore: number | null;
  scoreBreakdown: { grade: string; score: number } | null;
  summary: Record<string, unknown> | null;
  repository: { id: string; name: string; source: string };
}

export async function waitForAnalysis(session: Session, analysisId: string): Promise<AnalysisDto> {
  const analysis = await poll(
    `analysis ${analysisId}`,
    async () => (await session.get<AnalysisDto>(`/api/analysis/${analysisId}`)).data,
    (a) => a.status === "COMPLETED" || a.status === "FAILED",
    180_000,
  );
  if (analysis.status !== "COMPLETED") throw new Error(`Analysis ${analysisId} failed: ${analysis.error}`);
  return analysis;
}

export async function startDemo(session: Session): Promise<string> {
  const res = await session.post<{ analysisId: string }>("/api/analysis/demo");
  if (res.status !== 202) throw new Error(`Demo analysis not started: ${res.status} ${res.text.slice(0, 200)}`);
  return res.data.analysisId;
}

export const fixtureDir = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

export async function uploadFixture(session: Session, name: string): Promise<string> {
  const zip = await zipDirectory(fixtureDir(name), name);
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), `${name}.zip`);
  form.set("mode", "LOCAL_ONLY");
  const res = await session.request<{ analysisId: string }>("POST", "/api/analysis", { form });
  if (res.status !== 202) throw new Error(`Upload of ${name} not accepted: ${res.status} ${res.text.slice(0, 200)}`);
  return res.data.analysisId;
}

// Analyses are immutable snapshots, so specs in the same worker share them (Playwright runs with one worker).
const cache = new Map<string, Promise<AnalysisDto>>();
const cached = (key: string, make: () => Promise<AnalysisDto>) => {
  let p = cache.get(key);
  if (!p) {
    p = make();
    cache.set(key, p);
  }
  return p;
};
export const demoAnalysis = (session: Session) => cached(`demo:${session.user?.id}`, async () => waitForAnalysis(session, await startDemo(session)));
export const fixtureAnalysis = (session: Session, name: string) => cached(`${name}:${session.user?.id}`, async () => waitForAnalysis(session, await uploadFixture(session, name)));

// ---------------------------------------------------------------- planner and code engine

export interface PlanDto {
  id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  inProgress: boolean;
  approvedAt: string | null;
  provider: string;
  model: string;
  failureReason: string | null;
  error: string | null;
  plan: { affectedFiles: { path: string; change: string }[]; testPlan: { path: string | null }[] } | null;
  validation: { status: string; issues: unknown[] } | null;
}

export async function createTask(session: Session, analysisId: string, task: string): Promise<string> {
  const res = await session.post<{ id: string }>("/api/engineering/tasks", { analysisId, task });
  if (res.status !== 201) throw new Error(`Task not created: ${res.status} ${res.text.slice(0, 200)}`);
  return res.data.id;
}

/** Creates a task, plans it with the stub and waits for the plan to finish (completed or failed). */
export async function plannedTask(session: Session, analysisId: string, task: string): Promise<{ taskId: string; plan: PlanDto }> {
  const taskId = await createTask(session, analysisId, task);
  const started = await session.post<PlanDto>(`/api/engineering/tasks/${taskId}/plan`);
  if (started.status !== 202) throw new Error(`Planning not started: ${started.status} ${started.text.slice(0, 200)}`);
  const plan = await poll(
    `plan of task ${taskId}`,
    async () => (await session.get<PlanDto>(`/api/engineering/tasks/${taskId}/plan`)).data,
    (p) => !!p && !p.inProgress && (p.status === "COMPLETED" || p.status === "FAILED"),
    120_000,
  );
  return { taskId, plan };
}

export interface RunDto {
  id: string;
  status: string;
  inProgress: boolean;
  hasPatch: boolean;
  summary: string | null;
  testSetup: { test: { command: string } | null; install: { command: string } | null; needsInstall: boolean; image: string | null } | null;
  sandbox: { enabled: boolean; installEnabled: boolean };
  changes: { path: string; operation: string; status: string; diff: string | null }[];
  executions: { kind: string; command: string; network: boolean; exitCode: number | null; timedOut: boolean; output: string }[];
  events: { type: string }[];
}

export async function waitForRun(session: Session, runId: string, statuses: string[]): Promise<RunDto> {
  return poll(
    `run ${runId} to reach ${statuses.join("/")}`,
    async () => (await session.get<RunDto>(`/api/engineering/runs/${runId}`)).data,
    (r) => statuses.includes(r.status) || r.status === "FAILED" || r.status === "CANCELLED",
    240_000,
  );
}

export interface StubRequest {
  kind: "plan" | "edit" | null;
  model: string | null;
  user: string;
}

/** What the model stub received (kind, model, user message), newest last. */
export async function stubRequests(): Promise<StubRequest[]> {
  return ((await (await fetch(`${STUB_URL}/__stub/requests`)).json()) as { requests: StubRequest[] }).requests;
}

/**
 * An approved plan of the tiny-node fixture with a run ready for review (its tests skipped
 * when the sandbox asks for approval). Shared by the report and browser specs.
 */
let reviewed: Promise<{ analysisId: string; taskId: string; planId: string; run: RunDto }> | undefined;
export function reviewedRun(session: Session) {
  reviewed ??= (async () => {
    const analysisId = (await fixtureAnalysis(session, "tiny-node")).id;
    const { taskId, plan } = await plannedTask(session, analysisId, "Document the multiply function in src/math.js for the report checks.");
    if (plan.status !== "COMPLETED") throw new Error(`Plan failed: ${plan.error}`);
    if ((await session.post(`/api/engineering/plans/${plan.id}/approve`)).status !== 200) throw new Error("Plan not approved");
    const started = await session.post<RunDto>(`/api/engineering/plans/${plan.id}/runs`);
    if (started.status !== 201) throw new Error(`Run not started: ${started.status} ${started.text.slice(0, 200)}`);
    let run = await waitForRun(session, started.data.id, ["AWAITING_APPROVAL", "READY_FOR_REVIEW"]);
    if (run.status === "AWAITING_APPROVAL") {
      await session.post(`/api/engineering/runs/${run.id}/skip-tests`);
      run = await waitForRun(session, run.id, ["READY_FOR_REVIEW"]);
    }
    if (run.status !== "READY_FOR_REVIEW") throw new Error(`Run ended ${run.status}`);
    return { analysisId, taskId, planId: plan.id, run };
  })();
  return reviewed;
}
