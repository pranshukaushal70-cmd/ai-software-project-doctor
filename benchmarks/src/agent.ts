import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Session, signUp } from "@pd/e2e/client";
import { zipDirectory } from "@pd/e2e/zip";
import type { BenchmarkTask, Fixture } from "./ground-truth";

/**
 * Planner and code-engine evaluation. Runs every benchmark task through a running stack's
 * HTTP API (compose: docker-compose.e2e.yml with the model stub, or the real-model setup in
 * docs/benchmark.md), so what is measured is the product path: index → evidence → provider
 * → plan validation → approval → edit generation and validation → (optionally) sandboxed
 * tests. Stored code is discarded after each attempt.
 *
 * Success criteria (deterministic checks of the outcome; they say nothing about code
 * quality beyond them):
 * - planner: the plan completed, its validation is PASSED or WARNINGS, and it names every
 *   expected file for change.
 * - code engine: the run reached review, applied at least one change, changed at least one
 *   expected file, changed no forbidden file, and, when tests ran, they passed.
 */

export interface AgentOptions {
  label: string;
  repetitions: number;
  /** Approve the tests when the sandbox offers them and they need no install step. */
  runTests: boolean;
  log: (line: string) => void;
}

export interface Attempt {
  fixture: string;
  task: string;
  repetition: number;
  planner: {
    status: string;
    validationStatus: string | null;
    model: string | null;
    plannedFiles: string[];
    fileRecall: number;
    filePrecision: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
    error: string | null;
    success: boolean;
  };
  engine: {
    status: string;
    applied: string[];
    rejected: number;
    touchedExpected: boolean;
    touchedForbidden: string[];
    testsRun: boolean;
    testsPassed: boolean | null;
    inputTokens: number | null;
    outputTokens: number | null;
    wallMs: number;
    error: string | null;
    success: boolean;
  } | null;
}

interface PlanDto {
  id: string;
  status: string;
  inProgress: boolean;
  model: string | null;
  provider: string;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  plan: { affectedFiles: { path: string; change: string }[] } | null;
  validation: { status: string } | null;
}
interface RunDto {
  id: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  summary: string | null;
  testSetup: { needsInstall: boolean } | null;
  sandbox: { enabled: boolean };
  changes: { path: string; status: string; operation: string }[];
  executions: { kind: string; exitCode: number | null; timedOut: boolean }[];
}

const TERMINAL_RUN = ["READY_FOR_REVIEW", "AWAITING_APPROVAL", "FAILED", "CANCELLED", "DISCARDED"];

async function poll<T>(read: () => Promise<T>, done: (v: T) => boolean, what: string, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (done(v)) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

async function must<T>(res: Promise<{ status: number; data: T; text: string }>, expect: number[], what: string): Promise<T> {
  const r = await res;
  if (!expect.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${r.text.slice(0, 300)}`);
  return r.data;
}

async function analyse(session: Session, fixture: Fixture): Promise<string> {
  const started = fixture.truth.name === "storefront"
    ? await must(session.post<{ analysisId: string }>("/api/analysis/demo"), [202], "demo analysis")
    : await (async () => {
        const form = new FormData();
        const zip = await zipDirectory(fixture.sourceDir, fixture.truth.name);
        form.set("file", new Blob([new Uint8Array(zip)], { type: "application/zip" }), `${fixture.truth.name}.zip`);
        form.set("mode", "LOCAL_ONLY");
        return must(session.request<{ analysisId: string }>("POST", "/api/analysis", { form }), [202], "upload");
      })();
  const a = await poll(
    async () => (await session.get<{ status: string; error: string | null }>(`/api/analysis/${started.analysisId}`)).data,
    (x) => x.status === "COMPLETED" || x.status === "FAILED",
    `analysis of ${fixture.truth.name}`,
    300_000,
  );
  if (a.status !== "COMPLETED") throw new Error(`Analysis of ${fixture.truth.name} failed: ${a.error}`);
  return started.analysisId;
}

async function attempt(session: Session, analysisId: string, fixture: Fixture, task: BenchmarkTask, repetition: number, opts: AgentOptions): Promise<Attempt> {
  const created = await must(session.post<{ id: string }>("/api/engineering/tasks", { analysisId, task: task.task }), [201], "task");
  await must(session.post(`/api/engineering/tasks/${created.id}/plan`), [202], "plan request");
  const plan = await poll(
    async () => (await session.get<PlanDto>(`/api/engineering/tasks/${created.id}/plan`)).data,
    (p) => !!p && !p.inProgress && (p.status === "COMPLETED" || p.status === "FAILED"),
    `plan for ${task.id}`,
    20 * 60_000,
  );
  const planned = [...new Set((plan.plan?.affectedFiles ?? []).filter((f) => f.change !== "review").map((f) => f.path))].sort();
  const hits = task.expectedFiles.filter((f) => planned.includes(f)).length;
  const validationOk = plan.validation?.status === "PASSED" || plan.validation?.status === "WARNINGS";
  const planner: Attempt["planner"] = {
    status: plan.status,
    validationStatus: plan.validation?.status ?? null,
    model: plan.model,
    plannedFiles: planned,
    fileRecall: hits / task.expectedFiles.length,
    filePrecision: planned.length ? task.expectedFiles.filter((f) => planned.includes(f)).length / planned.length : null,
    inputTokens: plan.inputTokens,
    outputTokens: plan.outputTokens,
    durationMs: plan.durationMs,
    error: plan.error,
    success: plan.status === "COMPLETED" && validationOk && hits === task.expectedFiles.length,
  };
  if (plan.status !== "COMPLETED") return { fixture: fixture.truth.name, task: task.id, repetition, planner, engine: null };

  const started = Date.now();
  await must(session.post(`/api/engineering/plans/${plan.id}/approve`), [200], "approve");
  const runStart = await session.post<RunDto>(`/api/engineering/plans/${plan.id}/runs`);
  if (runStart.status !== 201) {
    const engine = { status: "NOT_STARTED", applied: [], rejected: 0, touchedExpected: false, touchedForbidden: [], testsRun: false, testsPassed: null, inputTokens: null, outputTokens: null, wallMs: 0, error: `HTTP ${runStart.status}: ${runStart.error?.message ?? ""}`, success: false };
    return { fixture: fixture.truth.name, task: task.id, repetition, planner, engine };
  }
  const readRun = async () => (await session.get<RunDto>(`/api/engineering/runs/${runStart.data.id}`)).data;
  let run = await poll(readRun, (r) => TERMINAL_RUN.includes(r.status), `run for ${task.id}`, 30 * 60_000);
  if (run.status === "AWAITING_APPROVAL") {
    if (opts.runTests && run.sandbox.enabled && run.testSetup && !run.testSetup.needsInstall) {
      await must(session.post(`/api/engineering/runs/${run.id}/execute`, { install: false }), [200], "execute");
    } else {
      await must(session.post(`/api/engineering/runs/${run.id}/skip-tests`), [200], "skip tests");
    }
    run = await poll(readRun, (r) => TERMINAL_RUN.includes(r.status) && r.status !== "AWAITING_APPROVAL", `review of ${task.id}`, 30 * 60_000);
  }
  const applied = [...new Set(run.changes.filter((c) => c.status === "APPLIED").map((c) => c.path))].sort();
  const testRuns = run.executions.filter((e) => e.kind === "TEST");
  const testsPassed = testRuns.length ? testRuns.at(-1)!.exitCode === 0 && !testRuns.at(-1)!.timedOut : null;
  const touchedForbidden = applied.filter((p) => task.forbiddenFiles.includes(p));
  const touchedExpected = applied.some((p) => task.expectedFiles.includes(p));
  const engine: NonNullable<Attempt["engine"]> = {
    status: run.status,
    applied,
    rejected: run.changes.filter((c) => c.status === "REJECTED").length,
    touchedExpected,
    touchedForbidden,
    testsRun: testRuns.length > 0,
    testsPassed,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    wallMs: Date.now() - started,
    error: run.status === "READY_FOR_REVIEW" ? null : run.summary,
    success: run.status === "READY_FOR_REVIEW" && applied.length > 0 && touchedExpected && touchedForbidden.length === 0 && testsPassed !== false,
  };
  // Stored patches contain repository code; nothing is kept after the measurement.
  if (run.status === "READY_FOR_REVIEW") await session.post(`/api/engineering/runs/${run.id}/discard`);
  return { fixture: fixture.truth.name, task: task.id, repetition, planner, engine };
}

// Per-user budgets of the web tier's rate limits (apps/web/server/rate-limit.ts): `ai` 30/h
// (a task and its plan request count 2), `engine` 10/h, `upload` 10/h.
const RUNS_PER_USER = 10;
const TASKS_PER_USER = 15;

export async function runAgentEvaluation(fixtures: readonly Fixture[], opts: AgentOptions) {
  const work = fixtures.flatMap((f) => f.truth.tasks.map((t) => ({ fixture: f, task: t })));
  if (!work.length) throw new Error("No benchmark tasks in the selected fixtures");
  const perRepetition = work.length;
  const repsPerUser = Math.max(1, Math.floor(Math.min(RUNS_PER_USER, TASKS_PER_USER) / perRepetition));
  const users = Math.ceil(opts.repetitions / repsPerUser);
  if (users > 4) throw new Error(`${opts.repetitions} repetitions of ${perRepetition} tasks need ${users} users; sign-ups are limited to 5 per hour. Use fewer repetitions.`);

  const startedAt = new Date().toISOString();
  const attempts: Attempt[] = [];
  let session: Session | null = null;
  let analyses = new Map<string, string>();
  for (let rep = 1; rep <= opts.repetitions; rep++) {
    if ((rep - 1) % repsPerUser === 0) {
      session = (await signUp(`bench${rep}`)).session;
      analyses = new Map();
    }
    for (const { fixture, task } of work) {
      if (!analyses.has(fixture.truth.name)) analyses.set(fixture.truth.name, await analyse(session!, fixture));
      opts.log(`[${rep}/${opts.repetitions}] ${fixture.truth.name} / ${task.id}`);
      const a = await attempt(session!, analyses.get(fixture.truth.name)!, fixture, task, rep, opts);
      opts.log(`    planner ${a.planner.success ? "ok" : "no"} (${a.planner.status}, ${a.planner.validationStatus ?? "-"}, files ${a.planner.plannedFiles.join(", ") || "-"})` + (a.engine ? `; engine ${a.engine.success ? "ok" : "no"} (${a.engine.status}, applied ${a.engine.applied.join(", ") || "-"})` : ""));
      attempts.push(a);
    }
  }
  return { startedAt, finishedAt: new Date().toISOString(), attempts, summary: summarize(attempts) };
}

const ratio = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 10_000) / 10_000);
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10_000) / 10_000 : null);

export function summarize(attempts: readonly Attempt[]) {
  const engineAttempts = attempts.filter((a) => a.engine);
  const tasks = [...new Set(attempts.map((a) => `${a.fixture}/${a.task}`))].sort();
  return {
    attempts: attempts.length,
    planner: {
      completed: attempts.filter((a) => a.planner.status === "COMPLETED").length,
      successes: attempts.filter((a) => a.planner.success).length,
      successRate: ratio(attempts.filter((a) => a.planner.success).length, attempts.length),
      meanFileRecall: mean(attempts.map((a) => a.planner.fileRecall)),
    },
    engine: {
      started: engineAttempts.filter((a) => a.engine!.status !== "NOT_STARTED").length,
      reachedReview: engineAttempts.filter((a) => a.engine!.status === "READY_FOR_REVIEW").length,
      testsRun: engineAttempts.filter((a) => a.engine!.testsRun).length,
      testsPassed: engineAttempts.filter((a) => a.engine!.testsPassed === true).length,
      successes: engineAttempts.filter((a) => a.engine!.success).length,
      // Over all attempts: a plan that failed counts as an engine failure too (end-to-end rate).
      successRate: ratio(engineAttempts.filter((a) => a.engine!.success).length, attempts.length),
    },
    perTask: tasks.map((key) => {
      const xs = attempts.filter((a) => `${a.fixture}/${a.task}` === key);
      return { task: key, attempts: xs.length, plannerSuccesses: xs.filter((a) => a.planner.success).length, engineSuccesses: xs.filter((a) => a.engine?.success).length };
    }),
  };
}

/** Digest of the fixtures' ground truth and sources, so results name exactly what they measured. */
export async function fixturesDigest(fixtures: readonly Fixture[]): Promise<string> {
  const hash = createHash("sha256");
  for (const f of fixtures) hash.update(f.truth.name).update(await readFile(path.join(f.dir, "ground-truth.json")));
  return hash.digest("hex").slice(0, 16);
}
