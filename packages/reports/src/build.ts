import { createHash } from "node:crypto";
import type { ReportOutcomeName, ReportStatusName } from "@pd/shared/constants";
import type { FindingRow, PlanInput, ReportInput, RunInput } from "./input";
import { cleanText, sanitizeDeep } from "./sanitize";
import {
  REPORT_VERSION,
  type AnalysisSection,
  type BuiltReport,
  type ChainStep,
  type CheckState,
  type FindingSummary,
  type Issue,
  type PlanSection,
  type ReportData,
  type RunSection,
  type SecuritySection,
  type TimelineEntry,
} from "./types";

/**
 * Builds a report from stored data. Pure and deterministic: the same input gives
 * the same snapshot and fingerprint (no clock, no randomness; lists keep the order
 * the collector loaded them in, which is fixed). Nothing is inferred: every state
 * comes from a stored status, timestamp or row, and what was not recorded is
 * reported as such ("not executed", "unavailable"), never as success.
 */

const LIMITS = {
  topFindings: 25,
  securityFindings: 15,
  languages: 10,
  dirs: 10,
  manifests: 20,
  docs: 10,
  entryPoints: 10,
  affectedFiles: 40,
  steps: 20,
  tests: 20,
  risks: 20,
  unknowns: 20,
  validationIssues: 15,
  changes: 100,
  executions: 10,
  outputTail: 2000,
  timeline: 150,
  notes: 20,
} as const;

/** Change flags that mean the code engine refused an edit for a security reason. */
const SECURITY_FLAGS = new Set(["forbidden-path", "secret", "touches-redacted", "insecure-change", "binary-content"]);
const ACTIVE_RUN = new Set(["QUEUED", "MATERIALIZING", "GENERATING", "VALIDATING", "APPLYING", "INSTALLING", "TESTING", "REPAIRING"]);

// ---------------------------------------------------------------- defensive readers for JSON columns

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strings = (v: unknown, max: number): string[] => arr(v).filter((x): x is string => typeof x === "string").slice(0, max);
/** Names of `{ name }` detections (frameworks, package managers, CI …). */
const names = (v: unknown, max = 20): string[] => [...new Set(arr(v).map((d) => str(obj(d)?.name)).filter((n): n is string => !!n))].slice(0, max);

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const duration = (start: Date | null, end: Date | null): number | null => (start && end ? Math.max(0, end.getTime() - start.getTime()) : null);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---------------------------------------------------------------- entry point

export function buildReport(input: ReportInput): BuiltReport {
  const analysis = analysisSection(input);
  const plan = input.type !== "ANALYSIS" && input.plan ? planSection(input.plan) : null;
  const run = input.type === "RUN" && input.run ? runSection(input.run) : null;
  if (input.type !== "ANALYSIS" && !plan) throw new Error("A plan or run report needs its plan");
  if (input.type === "RUN" && !run) throw new Error("A run report needs its run");

  const outcome = outcomeOf(input, analysis, plan, run);
  const status: ReportStatusName = outcome === "IN_PROGRESS" || outcome === "AWAITING_APPROVAL" ? "PARTIAL" : "COMPLETE";
  const issues = issuesOf(input, analysis, plan, run);
  const draft: ReportData = {
    version: REPORT_VERSION,
    type: input.type,
    status,
    outcome,
    title: titleOf(input),
    summary: summaryOf(input, analysis, plan, run, outcome, status),
    chain: chainOf(input, analysis, plan, run, outcome),
    repository: {
      name: input.repository.owner ? `${input.repository.owner}/${input.repository.name}` : input.repository.name,
      owner: input.repository.owner,
      source: input.repository.source,
      url: input.repository.url,
      branch: input.repository.branch,
      commitSha: input.analysis.commitSha,
    },
    analysis,
    plan,
    run,
    security: securityOf(input, run),
    issues,
    limitations: limitationsOf(input, analysis, run),
    timeline: timelineOf(input),
  };
  const data = sanitizeDeep(draft);
  const fingerprint = createHash("sha256").update(JSON.stringify(data)).digest("hex");
  return {
    type: data.type,
    status: data.status,
    outcome: data.outcome,
    title: data.title,
    summary: data.summary,
    errorCount: data.issues.errors.length,
    warningCount: data.issues.warnings.length,
    data,
    fingerprint,
  };
}

// ---------------------------------------------------------------- sections

const findingSummary = (f: FindingRow): FindingSummary => ({ severity: f.severity, category: f.category, ruleId: f.ruleId, title: f.title, path: f.path, line: f.line, triaged: f.triaged });

function analysisSection(input: ReportInput): AnalysisSection {
  const a = input.analysis;
  const s = obj(a.summary);
  const manifest = obj(obj(s?.intelligence)?.manifest);
  const totals = obj(s?.totals);
  const grade = str(obj(a.scoreBreakdown)?.grade);
  const docker = manifest ? [...strings(obj(manifest.docker)?.dockerfiles, 10), ...strings(obj(manifest.docker)?.compose, 10)] : names(s?.containers);
  const dirs = (v: unknown) =>
    arr(v)
      .map((d) => ({ path: str(obj(d)?.path), files: num(obj(d)?.files) }))
      .filter((d): d is { path: string; files: number } => !!d.path && d.files !== null)
      .slice(0, LIMITS.dirs);
  const vulnerabilityScan = str(obj(obj(s?.dependencies)?.vulnerabilityScan)?.status);
  return {
    id: a.id,
    status: a.status,
    stage: a.stage,
    analyzerVersion: a.analyzerVersion,
    error: a.error,
    createdAt: a.createdAt.toISOString(),
    startedAt: iso(a.startedAt),
    finishedAt: iso(a.finishedAt),
    durationMs: duration(a.startedAt, a.finishedAt),
    health: a.healthScore !== null && grade ? { score: a.healthScore, grade } : null,
    overview: s
      ? {
          files: num(totals?.files),
          lines: num(totals?.lines),
          primaryLanguage: str(s.primaryLanguage),
          languages: arr(s.languages)
            .map((l) => ({ language: str(obj(l)?.language), files: num(obj(l)?.files), lines: num(obj(l)?.lines) }))
            .filter((l): l is { language: string; files: number; lines: number } => !!l.language && l.files !== null && l.lines !== null)
            .slice(0, LIMITS.languages),
          frameworks: names(manifest?.frameworks ?? s.frameworks),
          testFrameworks: names(manifest?.testFrameworks),
          packageManagers: names(manifest?.packageManagers ?? s.packageManagers),
          buildSystems: names(manifest?.buildSystems ?? s.buildSystems),
          ci: names(manifest?.ci ?? s.ci),
          docker,
          entryPoints: names(manifest?.entryPoints ?? s.entryPoints, LIMITS.entryPoints),
          sourceDirs: dirs(manifest?.sourceDirs),
          testDirs: dirs(manifest?.testDirs),
          manifests: arr(manifest?.manifests)
            .map((m) => ({ path: str(obj(m)?.path), ecosystem: str(obj(m)?.ecosystem) }))
            .filter((m): m is { path: string; ecosystem: string } => !!m.path && !!m.ecosystem)
            .slice(0, LIMITS.manifests),
          documentation: strings(manifest?.documentation, LIMITS.docs),
          modulesRun: strings(s.modulesRun, 20),
        }
      : null,
    findings: {
      total: input.findings.total,
      triaged: input.findings.triaged,
      bySeverity: input.findings.bySeverity,
      byCategory: input.findings.byCategory,
      top: input.findings.top.slice(0, LIMITS.topFindings).map(findingSummary),
    },
    dependencies: { total: input.dependencies.total, vulnerable: input.dependencies.vulnerable, vulnerabilityScan },
  };
}

function planSection(p: PlanInput): PlanSection {
  const content = obj(p.plan);
  const validation = obj(p.validation);
  const issues = arr(validation?.issues).map((i) => ({ severity: str(obj(i)?.severity) ?? "error", code: str(obj(i)?.code) ?? "unknown", message: str(obj(i)?.message) ?? "" }));
  const completed = p.status === "COMPLETED";
  return {
    id: p.id,
    task: { id: p.task.id, request: p.task.request, scope: p.task.scope, constraints: strings(p.task.constraints, 10), createdAt: p.task.createdAt.toISOString() },
    status: p.status,
    provider: p.provider,
    model: p.model,
    createdAt: p.createdAt.toISOString(),
    finishedAt: iso(p.finishedAt),
    failureReason: p.failureReason,
    error: p.error,
    validationStatus: p.validationStatus,
    confidence: p.confidence,
    approval: {
      state: p.approvedAt ? "approved" : !completed ? "not_applicable" : p.isLatest ? "not_approved" : "superseded",
      approvedAt: iso(p.approvedAt),
    },
    content:
      completed && content
        ? {
            summary: str(content.taskSummary) ?? "",
            interpretation: str(content.interpretation) ?? "",
            affectedFiles: arr(content.affectedFiles)
              .slice(0, LIMITS.affectedFiles)
              .map((f) => ({ path: str(obj(f)?.path) ?? "", change: str(obj(f)?.change) ?? "", certainty: str(obj(f)?.certainty) ?? "UNKNOWN", flags: strings(obj(f)?.flags, 10) })),
            steps: arr(content.implementationSteps)
              .slice(0, LIMITS.steps)
              .map((st) => ({ title: str(obj(st)?.title) ?? "", files: strings(obj(st)?.files, 10) })),
            tests: arr(content.testPlan)
              .slice(0, LIMITS.tests)
              .map((t) => ({ description: str(obj(t)?.description) ?? "", path: str(obj(t)?.path), kind: str(obj(t)?.kind) ?? "" })),
            risks: arr(content.risks)
              .slice(0, LIMITS.risks)
              .map((r) => ({ severity: str(obj(r)?.severity) ?? "", description: str(obj(r)?.description) ?? "" })),
            unknowns: strings(content.unknowns, LIMITS.unknowns),
          }
        : null,
    validation: {
      errors: issues.filter((i) => i.severity === "error").length,
      warnings: issues.filter((i) => i.severity !== "error").length,
      issues: issues.slice(0, LIMITS.validationIssues),
    },
  };
}

function testsOf(r: RunInput): Omit<RunSection["tests"], "executions"> {
  const tests = r.executions.filter((e) => e.kind === "TEST");
  const last = tests.at(-1);
  if (ACTIVE_RUN.has(r.status)) {
    return { state: "pending", detail: r.status === "TESTING" || r.status === "INSTALLING" ? "Tests are running." : "The run is still in progress." };
  }
  if (r.status === "AWAITING_APPROVAL") return { state: "pending", detail: "Waiting for the user to approve the test command." };
  if (last) {
    if (last.exitCode === 0 && !last.timedOut) return { state: "passed", detail: `The last approved test run passed (${last.command}, exit code 0).` };
    return { state: "failed", detail: last.timedOut ? `The last approved test run timed out (${last.command}).` : `The last approved test run failed (${last.command}, exit code ${last.exitCode ?? "unknown"}).` };
  }
  if (r.status === "FAILED" || r.status === "CANCELLED") return { state: "not_executed", detail: "The run ended before any test ran." };
  if (r.events.some((e) => e.actor === "user" && e.fromStatus === "AWAITING_APPROVAL" && e.toStatus === "READY_FOR_REVIEW")) {
    return { state: "skipped", detail: "The user skipped the tests; nothing was executed." };
  }
  const notRun = r.events.find((e) => e.message.includes("Tests not run:"));
  if (notRun) return { state: "not_executed", detail: notRun.message.slice(notRun.message.indexOf("Tests not run:")) };
  return { state: "not_executed", detail: "No test run was recorded." };
}

function runSection(r: RunInput): RunSection {
  const setup = obj(r.testSetup);
  const changes = [...r.changes].sort((a, b) => a.iteration - b.iteration || a.path.localeCompare(b.path));
  const items = changes.slice(0, LIMITS.changes).map((c) => ({
    iteration: c.iteration,
    path: c.path,
    operation: c.operation,
    status: c.status === "APPLIED" ? ("APPLIED" as const) : ("REJECTED" as const),
    additions: c.additions,
    deletions: c.deletions,
    flags: strings(c.flags, 20),
    reason: c.reason,
  }));
  const applied = changes.filter((c) => c.status === "APPLIED");
  const rejected = changes.filter((c) => c.status !== "APPLIED");
  const iterations = [...new Set(changes.map((c) => c.iteration))].map((it) => ({
    iteration: it,
    accepted: changes.filter((c) => c.iteration === it && c.status === "APPLIED").length,
    rejected: changes.filter((c) => c.iteration === it && c.status !== "APPLIED").length,
  }));
  const reachedValidation = r.events.some((e) => e.toStatus === "VALIDATING");
  const validationState: CheckState = applied.length
    ? "passed"
    : reachedValidation
      ? ACTIVE_RUN.has(r.status)
        ? "pending"
        : "failed"
      : ACTIVE_RUN.has(r.status)
        ? "pending"
        : "not_executed";
  const executions = r.executions.slice(-LIMITS.executions).map((e) => ({
    iteration: e.iteration,
    kind: e.kind,
    command: e.command,
    image: e.image,
    network: e.network,
    exitCode: e.exitCode,
    timedOut: e.timedOut,
    durationMs: e.durationMs,
    outputTail: e.output.length > LIMITS.outputTail ? e.output.slice(e.output.length - LIMITS.outputTail) : e.output,
    outputTruncated: e.outputTruncated || e.output.length > LIMITS.outputTail,
  }));
  return {
    id: r.id,
    status: r.status,
    provider: r.provider,
    model: r.model,
    commitSha: r.commitSha,
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    durationMs: duration(r.startedAt ?? r.createdAt, r.finishedAt),
    failureReason: r.failureReason,
    error: r.error,
    cancelRequestedAt: iso(r.cancelRequestedAt),
    budgets: { maxIterations: r.maxIterations, tokenBudget: r.tokenBudget, maxDurationSeconds: r.maxDurationSeconds },
    usage: { iterations: r.iteration, inputTokens: r.inputTokens, outputTokens: r.outputTokens },
    summary: r.summary,
    notes: strings(r.notes, LIMITS.notes),
    execution: {
      approvedAt: iso(r.executionApprovedAt),
      installApproved: r.installApproved,
      testCommand: str(obj(setup?.test)?.display),
      installCommand: str(obj(setup?.install)?.display),
      image: str(setup?.image),
    },
    review: { state: r.status === "READY_FOR_REVIEW" ? "ready" : r.status === "DISCARDED" ? "discarded" : "not_reached", patchAvailable: r.hasPatch && r.status === "READY_FOR_REVIEW" },
    changes: {
      applied: applied.length,
      rejected: rejected.length,
      additions: applied.reduce((n, c) => n + c.additions, 0),
      deletions: applied.reduce((n, c) => n + c.deletions, 0),
      filesChanged: [...new Set(applied.map((c) => c.path))].sort(),
      items,
      truncated: r.changesTruncated || changes.length > LIMITS.changes,
    },
    validation: { state: validationState, iterations, blocked: rejected.slice(0, LIMITS.changes).map((c) => ({ path: c.path, flags: strings(c.flags, 20), reason: c.reason })) },
    tests: { ...testsOf(r), executions },
  };
}

function securityOf(input: ReportInput, run: RunSection | null): SecuritySection {
  const s = obj(input.analysis.summary);
  const envFiles = arr(s?.envFiles)
    .filter((e) => obj(e)?.isTemplate === false)
    .map((e) => str(obj(e)?.path))
    .filter((p): p is string => !!p)
    .slice(0, 20);
  const tests = run?.tests.executions.filter((e) => e.kind === "TEST") ?? [];
  const installs = run?.tests.executions.filter((e) => e.kind === "INSTALL") ?? [];
  const notes = [
    "Secret values are never included in reports: secret findings show the rule and the location only.",
    "Repository content is treated as untrusted. Prompt injection in repository content is not detected as such; its effect is bounded by the plan's scope, edit validation, the approval gates and human review.",
  ];
  if (run && tests.length) {
    notes.push(
      tests.every((e) => !e.network)
        ? "Approved tests ran in disposable containers without network access."
        : "At least one recorded test run had network access.",
    );
  }
  return {
    analysis: {
      secrets: input.findings.byCategory.SECRET ?? 0,
      insecurePatterns: input.findings.byCategory.SECURITY ?? 0,
      vulnerableDependencies: input.dependencies.vulnerable,
      committedEnvFiles: envFiles,
      findings: input.findings.security.slice(0, LIMITS.securityFindings).map(findingSummary),
    },
    run: run
      ? {
          blockedForSecurity: run.validation.blocked.filter((b) => b.flags.some((f) => SECURITY_FLAGS.has(f))).map((b) => ({ path: b.path, flags: b.flags.filter((f) => SECURITY_FLAGS.has(f)) })),
          sandbox: {
            used: run.tests.executions.length > 0,
            testsWithoutNetwork: tests.length ? tests.every((e) => !e.network) : null,
            installWithNetwork: installs.some((e) => e.network),
            images: [...new Set(run.tests.executions.map((e) => e.image))].sort(),
          },
        }
      : null,
    notes,
  };
}

// ---------------------------------------------------------------- outcome, chain, issues, limitations, timeline

function outcomeOf(input: ReportInput, analysis: AnalysisSection, plan: PlanSection | null, run: RunSection | null): ReportOutcomeName {
  if (input.type === "RUN" && run) {
    switch (run.status) {
      case "READY_FOR_REVIEW":
        return run.tests.state === "passed" ? "TESTS_PASSED" : run.tests.state === "failed" ? "TESTS_FAILED" : "NOT_TESTED";
      case "DISCARDED":
        return "DISCARDED";
      case "FAILED":
        return "FAILED";
      case "CANCELLED":
        return "CANCELLED";
      case "AWAITING_APPROVAL":
        return "AWAITING_APPROVAL";
      default:
        return "IN_PROGRESS";
    }
  }
  const status = input.type === "PLAN" && plan ? plan.status : analysis.status;
  return status === "COMPLETED" ? "COMPLETED" : status === "FAILED" ? "FAILED" : "IN_PROGRESS";
}

function titleOf(input: ReportInput): string {
  const repo = input.repository.owner ? `${input.repository.owner}/${input.repository.name}` : input.repository.name;
  const task = input.plan ? cleanText(input.plan.task.request, 80) : "";
  if (input.type === "ANALYSIS") return `Analysis report: ${repo}`;
  return `${input.type === "PLAN" ? "Plan" : "Run"} report: ${task} (${repo})`;
}

function summaryOf(input: ReportInput, a: AnalysisSection, plan: PlanSection | null, run: RunSection | null, outcome: ReportOutcomeName, status: ReportStatusName): string {
  const partial = status === "PARTIAL" ? " This report is partial; generate it again later." : "";
  if (input.type === "RUN" && run) {
    const files = plural(run.changes.filesChanged.length, "file");
    switch (outcome) {
      case "TESTS_PASSED":
        return `The run changed ${files} and the approved tests passed. Ready for review.`;
      case "TESTS_FAILED":
        return `The run changed ${files}; ${run.tests.detail.charAt(0).toLowerCase()}${run.tests.detail.slice(1)} Ready for review.`;
      case "NOT_TESTED":
        return `The run changed ${files}, but the changes were not tested: ${run.tests.detail} Ready for review.`;
      case "DISCARDED":
        return `The run changed ${files}; the user discarded the result.`;
      case "FAILED":
        return `The run failed: ${run.error ?? "no reason was recorded."}`;
      case "CANCELLED":
        return "The run was cancelled by the user.";
      case "AWAITING_APPROVAL":
        return `The run changed ${files} and is waiting for the user to approve its test command.${partial}`;
      default:
        return `The run is still in progress (${run.status.toLowerCase().replace(/_/g, " ")}).${partial}`;
    }
  }
  if (input.type === "PLAN" && plan) {
    if (outcome === "FAILED") return `Planning failed: ${plan.error ?? "no reason was recorded."}`;
    if (outcome === "IN_PROGRESS") return `The plan is still being generated.${partial}`;
    const approval = { approved: "approved for the code engine", not_approved: "not approved yet", superseded: "superseded by a newer plan", not_applicable: "not approvable" }[plan.approval.state];
    const conf = plan.confidence === null ? "" : `, confidence ${Math.round(plan.confidence * 100)}%`;
    return `The plan completed (validation ${plan.validationStatus ?? "unknown"}${conf}) and is ${approval}.`;
  }
  if (outcome === "FAILED") return `The analysis failed: ${a.error ?? "no reason was recorded."}`;
  if (outcome === "IN_PROGRESS") return `The analysis is still ${a.status.toLowerCase()} (stage ${a.stage.toLowerCase()}).${partial}`;
  const sev = a.findings.bySeverity;
  const serious = [sev.CRITICAL ? `${sev.CRITICAL} critical` : null, sev.HIGH ? `${sev.HIGH} high` : null].filter(Boolean).join(", ");
  const health = a.health ? `; health score ${a.health.score}/100 (${a.health.grade})` : "";
  return `The analysis completed with ${plural(a.findings.total, "finding")}${serious ? ` (${serious})` : ""}${health}.`;
}

function chainOf(input: ReportInput, a: AnalysisSection, plan: PlanSection | null, run: RunSection | null, outcome: ReportOutcomeName): ChainStep[] {
  const analysisState: CheckState = a.status === "COMPLETED" ? "passed" : a.status === "FAILED" ? "failed" : "pending";
  const ingestFailed = a.status === "FAILED" && (a.stage === "CLONING" || a.stage === "QUEUED");
  const steps: ChainStep[] = [
    {
      step: "repository",
      state: ingestFailed ? "failed" : a.status === "QUEUED" ? "pending" : "passed",
      detail: ingestFailed ? "The source could not be fetched or extracted." : `${input.repository.source}${input.analysis.commitSha ? ` at ${input.analysis.commitSha.slice(0, 12)}` : ""}`,
    },
    { step: "analysis", state: analysisState, detail: a.status === "COMPLETED" ? `${plural(a.findings.total, "finding")}` : a.status === "FAILED" ? (a.error ?? "Failed") : `Stage ${a.stage}` },
  ];
  if (plan) {
    steps.push({
      step: "plan",
      state: plan.status === "COMPLETED" ? "passed" : plan.status === "FAILED" ? "failed" : "pending",
      detail: plan.status === "COMPLETED" ? `Validation ${plan.validationStatus ?? "unknown"}` : plan.status === "FAILED" ? (plan.error ?? "Failed") : "In progress",
    });
    steps.push({
      step: "approval",
      state: plan.approval.state === "approved" ? "passed" : plan.approval.state === "not_approved" ? "pending" : "not_executed",
      detail: { approved: "Approved", not_approved: "Not approved yet", superseded: "Superseded by a newer plan", not_applicable: "The plan did not complete" }[plan.approval.state],
    });
  }
  if (run) {
    const runState: CheckState = ACTIVE_RUN.has(run.status) || run.status === "AWAITING_APPROVAL" ? "pending" : run.status === "FAILED" ? "failed" : run.status === "CANCELLED" ? "skipped" : "passed";
    steps.push({ step: "run", state: runState, detail: run.status === "FAILED" ? (run.error ?? "Failed") : run.status.replace(/_/g, " ").toLowerCase() });
    steps.push({
      step: "changes",
      state: run.changes.applied ? "passed" : runState === "pending" ? "pending" : "not_executed",
      detail: run.changes.applied ? `${plural(run.changes.filesChanged.length, "file")} (+${run.changes.additions} −${run.changes.deletions})` : "No change applied",
    });
    steps.push({ step: "validation", state: run.validation.state, detail: `${run.changes.applied} accepted, ${run.changes.rejected} rejected` });
    steps.push({ step: "tests", state: run.tests.state, detail: run.tests.detail });
  }
  const resultState: CheckState =
    outcome === "TESTS_PASSED" || outcome === "COMPLETED"
      ? "passed"
      : outcome === "FAILED" || outcome === "TESTS_FAILED"
        ? "failed"
        : outcome === "IN_PROGRESS" || outcome === "AWAITING_APPROVAL"
          ? "pending"
          : outcome === "NOT_TESTED"
            ? "unavailable"
            : "skipped";
  steps.push({ step: "result", state: resultState, detail: outcome.replace(/_/g, " ").toLowerCase() });
  return steps;
}

function issuesOf(input: ReportInput, a: AnalysisSection, plan: PlanSection | null, run: RunSection | null): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if (a.status === "FAILED") errors.push({ source: "analysis", message: a.error ?? "The analysis failed." });
  const scan = a.dependencies.vulnerabilityScan;
  if (scan && scan !== "completed" && scan !== "skipped") warnings.push({ source: "dependencies", message: `Dependency vulnerability lookup: ${scan}; known vulnerabilities may be missing.` });
  const intelligence = obj(obj(obj(input.analysis.summary)?.intelligence)?.truncated);
  if (intelligence && (intelligence.symbols === true || intelligence.references === true || intelligence.dependencies === true)) {
    warnings.push({ source: "index", message: "The repository index hit its size limits; some symbols or references are missing." });
  }
  if (obj(obj(input.analysis.summary)?.ignored)?.truncated === true) warnings.push({ source: "index", message: "The file limit was reached; not every file was analysed." });
  if (plan) {
    if (plan.status === "FAILED") errors.push({ source: "plan", message: plan.error ?? "Planning failed." });
    if (plan.validation.errors) warnings.push({ source: "plan", message: `Plan validation flagged ${plural(plan.validation.errors, "error")} (e.g. files or symbols not in the index).` });
  }
  if (run) {
    if (run.status === "FAILED") errors.push({ source: "run", message: run.error ?? "The run failed." });
    if (run.status === "CANCELLED") warnings.push({ source: "run", message: "The run was cancelled by the user." });
    if (run.validation.state === "failed") errors.push({ source: "validation", message: "No proposed change passed validation." });
    if (run.changes.rejected) warnings.push({ source: "validation", message: `${plural(run.changes.rejected, "proposed change")} rejected by validation.` });
    if (run.tests.state === "failed") errors.push({ source: "tests", message: run.tests.detail });
    if ((run.status === "READY_FOR_REVIEW" || run.status === "DISCARDED") && (run.tests.state === "not_executed" || run.tests.state === "skipped")) {
      warnings.push({ source: "tests", message: `The changes were not tested: ${run.tests.detail}` });
    }
  }
  return { errors, warnings };
}

function limitationsOf(input: ReportInput, a: AnalysisSection, run: RunSection | null): string[] {
  const out = ["Findings come from deterministic rules; the absence of a finding is not proof that no problem exists."];
  if (a.status === "COMPLETED" && (!a.overview || a.overview.modulesRun.length === 0)) out.push("This analysis was made by an older analyzer version; some sections have no data.");
  if (a.findings.top.length < a.findings.total) out.push(`Only the ${a.findings.top.length} most severe findings are listed; the analysis keeps all ${a.findings.total}.`);
  if (input.type !== "ANALYSIS") out.push("Reports contain no file contents or diffs; diffs are shown from the run while it keeps them (discarding a run deletes them).");
  if (run) {
    if (run.tests.state !== "passed") out.push("Without a passing test run, the behaviour of the changes is not verified.");
    if (run.tests.executions.length) out.push("Test runs used containers with the standard runtime unless the server configures gVisor; containers share the host kernel.");
    if (run.changes.truncated) out.push("The list of changes is truncated.");
    if (input.run?.eventsTruncated) out.push("Only the most recent run events are listed.");
    if (run.tests.executions.some((e) => e.outputTruncated)) out.push("Test output is shortened to its end; the full output stays with the run.");
  }
  return out;
}

function timelineOf(input: ReportInput): TimelineEntry[] {
  const out: Array<TimelineEntry & { order: number }> = [];
  let order = 0;
  const add = (at: Date | null, source: TimelineEntry["source"], event: string, actor: string | null) => {
    if (at) out.push({ at: at.toISOString(), source, event, actor, order: order++ });
  };
  const a = input.analysis;
  add(a.createdAt, "analysis", "Analysis requested", "user");
  add(a.startedAt, "analysis", "Analysis started", "worker");
  add(a.finishedAt, "analysis", a.status === "FAILED" ? "Analysis failed" : "Analysis finished", "worker");
  if (input.type !== "ANALYSIS" && input.plan) {
    const p = input.plan;
    add(p.task.createdAt, "plan", "Task created", "user");
    add(p.createdAt, "plan", "Plan requested", "user");
    add(p.finishedAt, "plan", p.status === "FAILED" ? "Planning failed" : "Plan generated", "worker");
    add(p.approvedAt, "plan", "Plan approved", "user");
  }
  if (input.type === "RUN" && input.run) {
    for (const e of input.run.events) add(e.createdAt, "run", e.message, e.actor);
  }
  return out
    .sort((x, y) => x.at.localeCompare(y.at) || x.order - y.order)
    .slice(-LIMITS.timeline)
    .map(({ order: _order, ...rest }) => rest);
}
