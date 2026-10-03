import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildEditContext, deriveEditScope, runEditor, unifiedDiff, type CodeEditProvider, type EditIssue, type ProposedChange, type RepairFeedback, type RepositoryFacts, type ValidatedPlan } from "@pd/agent";
import { checkChanges } from "@pd/agent/checks";
import { createWorkspace, fetchCommit, runGit, verifyFiles, type FileKind, type Workspace } from "@pd/analyzer";
import { redactSecrets } from "@pd/analyzer/evidence";
import { transitionRun, type Prisma, type PrismaClient } from "@pd/db";
import { resolveTestSetup, type ExecutionResult, type SandboxConfig, type SandboxDriver, type TestSetup } from "@pd/sandbox";
import { isTerminalRunStatus, type AnalyzerLimits, type EngineeringRunStatus } from "@pd/shared";
import type { Logger } from "@pd/shared/logger";
import { loadRepositoryGraph } from "./graph";
import { materializeRepository } from "./materialize";
import { readWorkspaceFile, writeWorkspaceFile } from "./workspace-files";

/**
 * The code engine's worker side (Phase 8). A run is processed in two jobs:
 *
 * - "start": rebuild the analysed source in a fresh workspace and verify it against
 *   the index, generate edits for the approved plan (LLM), validate and check them,
 *   apply them, store the cumulative patch, then either wait for the user to approve
 *   the sandboxed test command (AWAITING_APPROVAL) or, with no sandbox or no
 *   supported test setup, hand the result over for review (READY_FOR_REVIEW).
 * - "execute": after the approval, rebuild the source, apply the stored patch with
 *   `git apply` (which also proves the downloadable patch applies), install (if
 *   approved) and run the tests in the sandbox, and repair failures within the run's
 *   iteration, token and time budgets.
 *
 * Workspaces never outlive a job: a run that waits for the user is rebuilt from
 * stored data. Every status change goes through transitionRun (lifecycle and
 * approval gates); a cancel request is honoured between steps. Logs carry ids,
 * statuses and counts, never task text, prompts, file contents or patches.
 */

export interface EngineDeps {
  prisma: PrismaClient;
  log: Logger;
  limits: AnalyzerLimits;
  sandbox: SandboxDriver;
  sandboxConfig: Pick<SandboxConfig, "enabled" | "installEnabled" | "images">;
  /** The configured editing provider (credentials from the worker's environment only). */
  editProvider: () => CodeEditProvider;
  /** Checks of the applied result; defaults to the analyzer-based checkChanges. */
  check?: (changes: ProposedChange[]) => Promise<EditIssue[]>;
  demoDir?: string;
  fetchCommit?: typeof fetchCommit;
}

/** Stops the job without touching the run again (it was cancelled, failed or moved on). */
class Stop extends Error {}

/** Test output shown to the model when repairing: the end of it, where failures are reported. */
const REPAIR_OUTPUT_BYTES = 8 * 1024;
const REPAIR_DIFF_BYTES = 16 * 1024;
const RUN_SELECT = {
  id: true,
  userId: true,
  status: true,
  maxIterations: true,
  tokenBudget: true,
  maxDurationSeconds: true,
  iteration: true,
  inputTokens: true,
  outputTokens: true,
  installApproved: true,
  executionApprovedAt: true,
  cancelRequestedAt: true,
  patch: true,
  testSetup: true,
  plan: {
    select: {
      plan: true,
      approvedAt: true,
      task: {
        select: {
          userId: true,
          request: true,
          constraints: true,
          analysis: { select: { id: true, status: true, commitSha: true, summary: true, repository: { select: { userId: true, source: true, url: true, uploadKey: true } } } },
        },
      },
    },
  },
} satisfies Prisma.EngineeringRunSelect;
type RunRow = Prisma.EngineeringRunGetPayload<{ select: typeof RUN_SELECT }>;

export async function runEngineJob(runId: string, phase: "start" | "execute", deps: EngineDeps): Promise<void> {
  const { prisma } = deps;
  const log = deps.log.child({ runId, phase });
  const run = await prisma.engineeringRun.findUnique({ where: { id: runId }, select: RUN_SELECT });
  if (!run) return void log.warn("run not found; dropping job");
  const expected: EngineeringRunStatus[] = phase === "start" ? ["QUEUED"] : ["INSTALLING", "TESTING"];
  // A retried or duplicate job, or a run cancelled in the meantime: nothing to do.
  if (!expected.includes(run.status)) return void log.info({ status: run.status }, "run not in the expected status; skipping");

  const job = new RunJob(run, deps, log);
  try {
    if (phase === "start") await job.start();
    else await job.execute();
  } catch (err) {
    if (err instanceof Stop) return;
    log.error({ err: err instanceof Error ? { name: err.name, message: err.message } : String(err) }, "run crashed");
    await job.fail("internal-error", "The run failed unexpectedly.").catch(() => undefined);
  } finally {
    await job.dispose();
  }
}

class RunJob {
  private status: EngineeringRunStatus;
  private iteration: number;
  private tokens: number;
  private readonly deadline: number;
  private workspace: Workspace | null = null;
  private root = "";
  private facts!: RepositoryFacts;
  private plan!: ValidatedPlan;
  /** Original contents (null: did not exist) of every path changed so far, for the cumulative patch. */
  private readonly pristine = new Map<string, string | null>();
  private patch: string | null;

  constructor(
    private readonly run: RunRow,
    private readonly deps: EngineDeps,
    private readonly log: Logger,
  ) {
    this.status = run.status;
    this.iteration = run.iteration;
    this.tokens = run.inputTokens + run.outputTokens;
    this.patch = run.patch;
    // The time budget applies to each job (time spent waiting for the user does not count).
    this.deadline = Date.now() + run.maxDurationSeconds * 1000;
  }

  // ---------------------------------------------------------------- phases

  async start(): Promise<void> {
    await this.move("MATERIALIZING", "Rebuilding the analysed source.", { startedAt: new Date() });
    await this.prepare();
    const scope = deriveEditScope(this.plan, this.facts);
    if (!scope.modify.length && !scope.create.length && !scope.delete.length) {
      return this.fail("empty-scope", "The approved plan names no files the code engine may change.");
    }
    const applied = await this.generate(null);
    if (!applied) return;
    await this.afterApply();
  }

  async execute(): Promise<void> {
    if (!this.run.executionApprovedAt) return this.fail("not-approved", "The test command was not approved.");
    const setup = this.run.testSetup as TestSetup | null;
    if (!setup) return this.fail("no-test-setup", "This run has no test setup.");
    await this.prepare();
    await this.applyStoredPatch();
    await this.testLoop(setup);
  }

  // ---------------------------------------------------------------- steps

  /** Rebuilds and verifies the analysed source; loads the plan and the repository facts. */
  private async prepare(): Promise<void> {
    const { prisma, limits } = this.deps;
    const { task } = this.run.plan;
    const analysis = task.analysis;
    // Ownership is re-checked: run, task and analysis must belong to the same user.
    if (task.userId !== this.run.userId || analysis.repository.userId !== this.run.userId || !this.run.plan.approvedAt || !this.run.plan.plan) {
      return this.fail("not-allowed", "The run's plan is not approved for this user.");
    }
    this.plan = this.run.plan.plan as unknown as ValidatedPlan;
    this.workspace = await createWorkspace(limits.workspaceDir, `run-${this.run.id}`);
    try {
      const m = await materializeRepository(
        { source: analysis.repository.source, url: analysis.repository.url, uploadKey: analysis.repository.uploadKey, commitSha: analysis.commitSha },
        this.workspace.dir,
        { limits, demoDir: this.deps.demoDir, fetchCommit: this.deps.fetchCommit },
      );
      this.root = m.root;
      if (m.commitSha) await prisma.engineeringRun.update({ where: { id: this.run.id }, data: { commitSha: m.commitSha } });
    } catch (err) {
      const message = err instanceof Error && "code" in err ? err.message : "The analysed source could not be rebuilt.";
      return this.fail("materialize-failed", message);
    }
    await this.checkCancel();

    const [files, graph] = await Promise.all([
      prisma.file.findMany({ where: { analysisId: analysis.id }, select: { path: true, kind: true, contentHash: true } }),
      loadRepositoryGraph(prisma, analysis),
    ]);
    this.facts = {
      files: new Map(files.map((f) => [f.path, f.kind as FileKind] as const)),
      hasSymbol: (name, p) => {
        const leaf = name.split(".").pop() ?? name;
        return graph.findSymbols(leaf, p).some((s) => s.name === leaf);
      },
    };
    // Everything the engine may read or change must be exactly what the analysis indexed.
    const plan = this.run.plan.plan as unknown as ValidatedPlan;
    const scope = deriveEditScope(plan, this.facts);
    const relevant = new Set([...scope.modify, ...scope.delete, ...plan.affectedFiles.map((f) => f.path), ...plan.affectedSymbols.map((s) => s.path)]);
    const verified = await verifyFiles(this.root, files.filter((f) => relevant.has(f.path)));
    if (verified.mismatched.length || verified.missing.length) {
      this.log.warn({ mismatched: verified.mismatched.length, missing: verified.missing.length }, "rebuilt source differs from the analysis");
      return this.fail("source-changed", "The rebuilt source does not match the analysis; run a new analysis.");
    }
  }

  /**
   * One generation: GENERATING (first) or REPAIRING, then VALIDATING, then APPLYING.
   * Returns true when changes were applied; otherwise the run has moved to review
   * (an earlier result exists) or failed, or another repair round was started.
   */
  private async generate(repair: RepairFeedback | null): Promise<boolean> {
    const { prisma } = this.deps;
    for (;;) {
      if (this.iteration >= this.run.maxIterations) return this.noMoreChanges("The iteration budget is used up.");
      if (this.tokens >= this.run.tokenBudget) return this.noMoreChanges("The token budget is used up.");
      await this.checkTime();
      this.iteration++;
      await this.move(repair ? "REPAIRING" : "GENERATING", repair ? `Repair attempt ${this.iteration - 1}.` : "Generating changes for the approved plan.", { iteration: this.iteration });

      let provider: CodeEditProvider;
      try {
        provider = this.deps.editProvider();
      } catch (err) {
        return this.fail("not-configured", err instanceof Error ? err.message : "No AI provider is configured for the worker.");
      }
      const scope = deriveEditScope(this.plan, this.facts);
      const { context, originals } = await buildEditContext({
        task: { request: this.run.plan.task.request, constraints: (this.run.plan.task.constraints as string[] | null) ?? [] },
        plan: this.plan,
        scope,
        // Files created by earlier iterations are not in the index but are part of the result.
        facts: this.factsWithCreated(),
        readFile: (p) => readWorkspaceFile(this.root, p),
        repair,
      });
      const result = await runEditor(context, originals, provider, this.factsWithCreated(), { check: this.deps.check ?? checkChanges });
      this.tokens += (result.meta.inputTokens ?? 0) + (result.meta.outputTokens ?? 0);
      await prisma.engineeringRun.update({
        where: { id: this.run.id },
        data: { model: result.meta.model, inputTokens: { increment: result.meta.inputTokens ?? 0 }, outputTokens: { increment: result.meta.outputTokens ?? 0 } },
      });
      this.log.info(
        { iteration: this.iteration, ok: result.ok, accepted: result.ok ? result.report.accepted : 0, rejected: result.ok ? result.report.rejected : 0, inputTokens: result.meta.inputTokens, outputTokens: result.meta.outputTokens },
        "changes generated",
      );
      await this.checkCancel();

      if (!result.ok) {
        // A provider failure ends the run, unless an earlier result exists: then that goes to review.
        if (this.patch) return this.noMoreChanges(`The repair attempt failed: ${result.message}`);
        return this.fail(result.reason, result.message);
      }

      await this.move("VALIDATING", `${result.report.accepted} change(s) accepted, ${result.report.rejected} rejected.`, { summary: result.summary, notes: result.notes });
      await this.storeChanges(result.changes);
      const accepted = result.changes.filter((c) => c.status === "accepted");
      if (!accepted.length) {
        const problems = result.report.issues.slice(0, 20).map((i) => `${i.path ? `${i.path}: ` : ""}${i.message}`);
        if (this.iteration < this.run.maxIterations && this.tokens < this.run.tokenBudget) {
          repair = { iteration: this.iteration, previousDiff: truncate(this.patch ?? "", REPAIR_DIFF_BYTES), problems: ["No proposed change passed validation.", ...problems], testOutput: null };
          continue;
        }
        return this.noMoreChanges("No proposed change passed validation.");
      }

      await this.move("APPLYING", `Applying ${accepted.length} change(s).`);
      for (const c of accepted) {
        if (!this.pristine.has(c.path)) this.pristine.set(c.path, c.before);
        await writeWorkspaceFile(this.root, c.path, c.after);
      }
      await this.storePatch();
      return true;
    }
  }

  /** After a first application: wait for test approval, or go to review when tests cannot run. */
  private async afterApply(): Promise<void> {
    const { sandbox, sandboxConfig } = this.deps;
    const status = sandboxConfig.enabled ? await sandbox.status() : { available: false as const, reason: "Sandboxed test runs are disabled on this server." };
    if (!status.available) return void (await this.move("READY_FOR_REVIEW", `Ready for review. Tests not run: ${status.reason}`));
    const files = new Set([...this.facts.files.keys(), ...[...this.pristine.entries()].filter(([, before]) => before === null).map(([p]) => p)]);
    const resolved = await resolveTestSetup({ files, readFile: (p) => readWorkspaceFile(this.root, p), config: sandboxConfig });
    if (!resolved.ok) return void (await this.move("READY_FOR_REVIEW", `Ready for review. Tests not run: ${resolved.reason}`));
    await this.move("AWAITING_APPROVAL", `Waiting for approval to run ${resolved.setup.test.display} in the sandbox.`, { testSetup: resolved.setup as unknown as Prisma.InputJsonValue });
  }

  /** Re-applies the stored cumulative patch to the freshly rebuilt source. */
  private async applyStoredPatch(): Promise<void> {
    if (!this.patch) return this.fail("no-patch", "There is no change to test.");
    for (const p of patchPaths(this.patch)) this.pristine.set(p, await readWorkspaceFile(this.root, p));
    const file = path.join(this.workspace!.dir, "run.patch");
    await writeFile(file, this.patch, "utf8");
    const r = await runGit(["apply", "--whitespace=nowarn", "--", file], { cwd: this.root, timeoutMs: 60_000 });
    if (r.code !== 0) {
      this.log.warn({ gitExitCode: r.code }, "stored patch does not apply");
      return this.fail("patch-failed", "The stored change no longer applies to the analysed source.");
    }
  }

  /** Install (when approved), test, and repair failures while the budgets allow. */
  private async testLoop(setup: TestSetup): Promise<void> {
    for (;;) {
      await this.checkTime();
      let installFailed = false;
      const session = await this.deps.sandbox.open(this.run.id, this.root, setup).catch((err: unknown) => {
        this.log.warn({ err: err instanceof Error ? err.message : String(err) }, "sandbox could not be prepared");
        return null;
      });
      if (!session) return this.fail("sandbox-error", "The sandbox could not be prepared.");
      let test: ExecutionResult;
      try {
        if (this.status === "INSTALLING") {
          const install = await session.install();
          await this.storeExecution(install);
          installFailed = install.exitCode !== 0;
          await this.checkCancel();
          await this.move("TESTING", installFailed ? "Dependency install failed; running the tests anyway." : "Dependencies installed.");
        }
        test = await session.test();
        await this.storeExecution(test);
      } finally {
        await session.close();
      }
      await this.checkCancel();
      this.log.info({ iteration: this.iteration, exitCode: test.exitCode, timedOut: test.timedOut }, "tests ran");

      if (test.exitCode === 0) return void (await this.move("READY_FOR_REVIEW", "Tests passed. Ready for review."));
      const why = test.timedOut ? "The tests timed out." : `The tests failed (exit code ${test.exitCode}).`;
      // Missing or failed dependencies are an environment problem a code change cannot fix: no repair round is spent on them.
      const environment = installFailed
        ? "the dependency install failed"
        : setup.needsInstall && !this.run.installApproved
          ? "the tests need their dependencies, and the install step was not approved"
          : null;
      const canRepair = !environment && this.iteration < this.run.maxIterations && this.tokens < this.run.tokenBudget && Date.now() < this.deadline;
      if (!canRepair) return void (await this.move("READY_FOR_REVIEW", `${why} Ready for review${environment ? ` (${environment}; not repaired)` : ", no repair attempts left"}.`));

      const repaired = await this.generate({ iteration: this.iteration, previousDiff: truncate(this.patch ?? "", REPAIR_DIFF_BYTES), problems: [why], testOutput: tail(test.output, REPAIR_OUTPUT_BYTES) });
      if (!repaired) return;
      await this.move(this.run.installApproved ? "INSTALLING" : "TESTING", "Re-running the approved tests on the repaired change.");
    }
  }

  // ---------------------------------------------------------------- persistence

  private async storeChanges(changes: ProposedChange[]): Promise<void> {
    if (!changes.length) return;
    await this.deps.prisma.engineeringChange.createMany({
      data: changes.map((c) => ({
        runId: this.run.id,
        iteration: this.iteration,
        path: c.path,
        operation: c.operation === "create" ? ("CREATE" as const) : c.operation === "delete" ? ("DELETE" as const) : ("MODIFY" as const),
        status: c.status === "accepted" ? ("APPLIED" as const) : ("REJECTED" as const),
        reason: c.reason,
        beforeHash: c.before === null ? null : sha256(c.before),
        afterHash: c.after === null ? null : sha256(c.after),
        diff: c.status === "accepted" ? c.diff : null,
        additions: c.additions,
        deletions: c.deletions,
        flags: c.flags,
      })),
    });
  }

  /** The cumulative patch from the analysed source to the current workspace, in path order. */
  private async storePatch(): Promise<void> {
    let patch = "";
    for (const p of [...this.pristine.keys()].sort()) {
      const after = await readWorkspaceFile(this.root, p);
      patch += unifiedDiff(p, this.pristine.get(p) ?? null, after).diff;
    }
    this.patch = patch || null;
    await this.deps.prisma.engineeringRun.update({ where: { id: this.run.id }, data: { patch: this.patch } });
  }

  private async storeExecution(r: ExecutionResult): Promise<void> {
    await this.deps.prisma.sandboxExecution.create({
      data: {
        runId: this.run.id,
        iteration: this.iteration,
        kind: r.kind,
        commandId: r.commandId,
        command: r.command,
        image: r.image,
        network: r.network,
        exitCode: r.exitCode,
        timedOut: r.timedOut,
        durationMs: r.durationMs,
        output: r.output,
        outputTruncated: r.outputTruncated,
        finishedAt: new Date(),
      },
    });
  }

  // ---------------------------------------------------------------- lifecycle helpers

  /** Moves the run; stops the job when it already moved on (e.g. a concurrent cancel). */
  private async move(to: EngineeringRunStatus, message: string, patch?: Prisma.EngineeringRunUpdateManyMutationInput): Promise<void> {
    const moved = await transitionRun(this.deps.prisma, this.run.id, { from: this.status, to, actor: "worker", message, patch });
    if (!moved) {
      this.log.info({ from: this.status, to }, "run moved on concurrently; stopping");
      throw new Stop();
    }
    this.status = to;
  }

  async fail(reason: string, message: string): Promise<never> {
    if (!isTerminalRunStatus(this.status) && this.status !== "READY_FOR_REVIEW") {
      await transitionRun(this.deps.prisma, this.run.id, { from: this.status, to: "FAILED", actor: "worker", message, patch: { failureReason: reason, error: message } }).catch(() => false);
      this.status = "FAILED";
      this.log.info({ failureReason: reason }, "run failed");
    }
    throw new Stop();
  }

  /** No (further) valid change: review the earlier result if there is one, otherwise fail. */
  private async noMoreChanges(reason: string): Promise<false> {
    if (!this.patch) return this.fail("no-valid-changes", `${reason} No valid change was produced.`);
    // Generation statuses lead to review only through VALIDATING (the lifecycle has no shortcut).
    if (this.status === "GENERATING" || this.status === "REPAIRING") await this.move("VALIDATING", reason);
    await this.move("READY_FOR_REVIEW", `${reason} The previous result is ready for review.`);
    return false;
  }

  private async checkCancel(): Promise<void> {
    const r = await this.deps.prisma.engineeringRun.findUnique({ where: { id: this.run.id }, select: { cancelRequestedAt: true, status: true } });
    if (!r || r.status !== this.status) throw new Stop();
    if (r.cancelRequestedAt) {
      await this.move("CANCELLED", "Cancelled by the user.");
      throw new Stop();
    }
  }

  private async checkTime(): Promise<void> {
    if (Date.now() > this.deadline) await this.fail("time-budget", "The run exceeded its time budget.");
  }

  private factsWithCreated(): RepositoryFacts {
    const created = [...this.pristine.entries()].filter(([, before]) => before === null).map(([p]) => p);
    if (!created.length) return this.facts;
    const files = new Map(this.facts.files);
    for (const p of created) files.set(p, "SOURCE");
    return { files, hasSymbol: this.facts.hasSymbol };
  }

  async dispose(): Promise<void> {
    await this.workspace?.dispose().catch((err) => this.log.warn({ err }, "workspace cleanup failed"));
    this.workspace = null;
  }
}

// ---------------------------------------------------------------- helpers

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Paths named in a git-format patch (`diff --git a/X b/X`). */
export function patchPaths(patch: string): string[] {
  const out = new Set<string>();
  for (const m of patch.matchAll(/^diff --git a\/(.+?) b\/\1$/gm)) out.add(m[1]!);
  return [...out];
}

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n[truncated]` : s);
const tail = (s: string, max: number) => redactSecrets(s.length > max ? s.slice(s.length - max) : s);
