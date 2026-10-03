import { fileRole } from "@pd/analyzer/intelligence";
// The dependency-free redaction module, not "@pd/analyzer/metrics" (which loads the tree-sitter parser).
import { redactSecrets } from "@pd/analyzer/evidence";
import type { FileKind } from "@pd/analyzer";
import { PlanOutputSchema, type Certainty, type PlanOutput, type PlanningContext } from "./schema";

/**
 * Deterministic validation of a generated plan. Model output is untrusted input:
 * it is parsed against the schema, every repository reference is checked against
 * the index, VERIFIED claims must cite real evidence, and text is scrubbed of
 * secrets, shell commands and paths outside the repository. Problems are flagged on
 * the item they concern (the item stays visible) and summarised in the report.
 */

export interface RepositoryFacts {
  /** Every file of the analysis with its kind. */
  files: ReadonlyMap<string, FileKind>;
  /** Whether a declaration with this name exists (in this file, when given). */
  hasSymbol(name: string, path?: string): boolean;
}

export type IssueSeverity = "error" | "warning";
export interface ValidationIssue {
  severity: IssueSeverity;
  code:
    | "schema"
    | "unknown-evidence"
    | "unsupported-verified"
    | "nonexistent-file"
    | "file-exists"
    | "invalid-path"
    | "secret-file"
    | "nonexistent-symbol"
    | "test-not-found"
    | "implausible-test-path"
    | "unlisted-step-file"
    | "command"
    | "secret";
  /** JSON path of the item, e.g. `affectedFiles[2].path`. */
  field: string;
  message: string;
}

export type ValidationStatus = "PASSED" | "WARNINGS" | "ERRORS" | "REJECTED";

export interface ValidationReport {
  status: ValidationStatus;
  issues: ValidationIssue[];
  /** The model's stated confidence, clamped to 0–1. */
  modelConfidence: number;
  /** Lowered for every validation problem: what the UI shows. */
  confidence: number;
}

/** A plan item after validation: `flags` lists the issue codes that concern it. */
export type Flagged<T> = T & { flags: string[] };

export interface ValidatedPlan extends Omit<PlanOutput, "affectedFiles" | "affectedSymbols" | "testPlan" | "configurationChanges" | "implementationSteps"> {
  affectedFiles: Array<Flagged<PlanOutput["affectedFiles"][number]>>;
  affectedSymbols: Array<Flagged<PlanOutput["affectedSymbols"][number]>>;
  testPlan: Array<Flagged<PlanOutput["testPlan"][number]>>;
  configurationChanges: Array<Flagged<PlanOutput["configurationChanges"][number]>>;
  implementationSteps: Array<Flagged<PlanOutput["implementationSteps"][number]>>;
}

export const PLAN_LIMITS = { listItems: 40, text: 2000, evidencePerItem: 12, validationPlan: 20 } as const;

/** Shell-command shapes the plan must not contain: it describes work, it never prescribes commands to run. */
export const COMMAND =
  /(?:^|[\s`$>;(|&])(?:sudo|rm\s+-[rf]|curl\s+\S|wget\s+\S|npm\s+(?:i|install|ci|run|exec|uninstall)\b|npx\s+\S|pnpm\s+\S|yarn\s+(?:add|install|run)\b|pip3?\s+install|chmod\s+\d|chown\s+\S|bash\s+-c|sh\s+-c|powershell(?:\.exe)?\s|cmd(?:\.exe)?\s+\/c|git\s+(?:push|commit|reset|clean|checkout|rebase|merge|add)\b|docker\s+(?:run|exec|build)\b|kubectl\s+\S|eval\s*\(|exec\s*\(|child_process|os\.system|subprocess\.)/i;
export const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|spec|specs|e2e)\/|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$|Tests?\.java$/;
export const REMOVED_COMMAND = "[shell command removed by validation]";

export const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
export const isRepoPath = (p: string) =>
  p.length > 0 && p.length <= 1000 && !p.startsWith("/") && !p.startsWith("~") && !/^[A-Za-z]:/.test(p) && !p.includes("\\") && !p.includes("\0") && !p.split("/").includes("..");

export function validatePlan(raw: unknown, context: PlanningContext, facts: RepositoryFacts): { plan: ValidatedPlan | null; report: ValidationReport } {
  const parsed = PlanOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: ValidationIssue[] = parsed.error.issues.slice(0, 20).map((i) => ({
      severity: "error",
      code: "schema",
      field: i.path.join(".") || "(root)",
      message: `Output does not match the plan schema: ${i.message}`,
    }));
    return { plan: null, report: { status: "REJECTED", issues, modelConfidence: 0, confidence: 0 } };
  }

  const issues: ValidationIssue[] = [];
  const issue = (severity: IssueSeverity, code: ValidationIssue["code"], field: string, message: string) => {
    issues.push({ severity, code, field, message });
    return code;
  };
  const evidenceIds = new Set(context.evidence.map((e) => e.id));

  // Text hygiene on every string: secrets are redacted, commands removed, length bounded.
  const clean = (text: string, field: string): string => {
    let t = text.length > PLAN_LIMITS.text ? `${text.slice(0, PLAN_LIMITS.text - 1)}…` : text;
    const redacted = redactSecrets(t);
    if (redacted !== t) {
      issue("error", "secret", field, "Text contained a value that looks like a credential; it was redacted.");
      t = redacted;
    }
    if (COMMAND.test(t)) {
      issue("error", "command", field, "Text contained a shell command; plans describe work and never prescribe commands.");
      t = REMOVED_COMMAND;
    }
    return t;
  };
  const cleanEvidence = (ids: string[], field: string) => {
    const kept: string[] = [];
    for (const id of ids.slice(0, PLAN_LIMITS.evidencePerItem)) {
      if (evidenceIds.has(id)) kept.push(id);
      else issue("warning", "unknown-evidence", field, `Cited evidence "${id.slice(0, 20)}" is not in the context and was removed.`);
    }
    return [...new Set(kept)];
  };
  /** A claim is VERIFIED only with evidence behind it. */
  const settle = (c: Certainty, ev: string[], field: string): Certainty => {
    if (c === "VERIFIED" && ev.length === 0) {
      issue("warning", "unsupported-verified", field, "Marked VERIFIED without valid evidence; downgraded to INFERRED.");
      return "INFERRED";
    }
    return c;
  };
  const checkPath = (path: string, field: string, flags: string[]): string => {
    if (!isRepoPath(path)) {
      flags.push(issue("error", "invalid-path", field, `"${path.slice(0, 80)}" is not a path inside the repository; removed.`));
      return "[invalid path removed]";
    }
    const kind = facts.files.get(path);
    if (kind && fileRole(path, kind) === "secret") flags.push(issue("warning", "secret-file", field, `${path} holds secrets; plans must not change or read it.`));
    return path;
  };
  const claim = (c: PlanOutput["assumptions"][number], field: string) => {
    const ev = cleanEvidence(c.evidence, `${field}.evidence`);
    return { statement: clean(c.statement, `${field}.statement`), certainty: settle(c.certainty, ev, field), evidence: ev };
  };
  const list = <T>(items: T[]) => items.slice(0, PLAN_LIMITS.listItems);
  const p = parsed.data;

  const affectedFiles = list(p.affectedFiles).map((f, i) => {
    const field = `affectedFiles[${i}]`;
    const flags: string[] = [];
    const path = checkPath(f.path, `${field}.path`, flags);
    const ev = cleanEvidence(f.evidence, `${field}.evidence`);
    let certainty = settle(f.certainty, ev, field);
    const exists = facts.files.has(path);
    if (f.change !== "create" && !exists && !flags.includes("invalid-path")) {
      flags.push(issue("error", "nonexistent-file", `${field}.path`, `${path} does not exist in the repository index.`));
      certainty = "UNKNOWN";
    }
    if (f.change === "create" && exists) flags.push(issue("warning", "file-exists", `${field}.path`, `${path} already exists; "create" would overwrite it.`));
    return { ...f, path, reason: clean(f.reason, `${field}.reason`), certainty, evidence: ev, flags };
  });

  const affectedSymbols = list(p.affectedSymbols).map((s, i) => {
    const field = `affectedSymbols[${i}]`;
    const flags: string[] = [];
    const path = checkPath(s.path, `${field}.path`, flags);
    const ev = cleanEvidence(s.evidence, `${field}.evidence`);
    let certainty = settle(s.certainty, ev, field);
    if (s.change !== "create" && !flags.includes("invalid-path") && !facts.hasSymbol(s.name, path)) {
      flags.push(issue("error", "nonexistent-symbol", `${field}.name`, `No declaration named ${s.name.slice(0, 80)} exists in ${path}.`));
      certainty = "UNKNOWN";
    }
    return { ...s, name: clean(s.name, `${field}.name`), path, reason: clean(s.reason, `${field}.reason`), certainty, evidence: ev, flags };
  });

  const known = new Set([...affectedFiles.map((f) => f.path), ...facts.files.keys()]);
  const implementationSteps = list(p.implementationSteps).map((s, i) => {
    const field = `implementationSteps[${i}]`;
    const flags: string[] = [];
    const files = s.files.slice(0, PLAN_LIMITS.listItems).map((f, j) => {
      const path = checkPath(f, `${field}.files[${j}]`, flags);
      if (!flags.includes("invalid-path") && !known.has(path)) flags.push(issue("warning", "unlisted-step-file", `${field}.files[${j}]`, `${path} is neither an existing file nor listed in affectedFiles.`));
      return path;
    });
    return { title: clean(s.title, `${field}.title`), description: clean(s.description, `${field}.description`), files, evidence: cleanEvidence(s.evidence, `${field}.evidence`), flags };
  });

  const testPlan = list(p.testPlan).map((t, i) => {
    const field = `testPlan[${i}]`;
    const flags: string[] = [];
    let path = t.path;
    if (path !== null) {
      path = checkPath(path, `${field}.path`, flags);
      if (!flags.includes("invalid-path")) {
        if (t.kind === "existing" && facts.files.get(path) !== "TEST") flags.push(issue("error", "test-not-found", `${field}.path`, `${path} is not an existing test file.`));
        if (t.kind === "new" && !TEST_PATH.test(path)) flags.push(issue("warning", "implausible-test-path", `${field}.path`, `${path} does not look like a test file for this repository's conventions.`));
      }
    }
    return { ...t, path, description: clean(t.description, `${field}.description`), evidence: cleanEvidence(t.evidence, `${field}.evidence`), flags };
  });

  const configurationChanges = list(p.configurationChanges).map((c, i) => {
    const field = `configurationChanges[${i}]`;
    const flags: string[] = [];
    const path = checkPath(c.path, `${field}.path`, flags);
    const ev = cleanEvidence(c.evidence, `${field}.evidence`);
    return { ...c, path, description: clean(c.description, `${field}.description`), certainty: settle(c.certainty, ev, field), evidence: ev, flags };
  });

  const plan: ValidatedPlan = {
    taskSummary: clean(p.taskSummary, "taskSummary"),
    interpretation: clean(p.interpretation, "interpretation"),
    assumptions: list(p.assumptions).map((c, i) => claim(c, `assumptions[${i}]`)),
    affectedFiles,
    affectedSymbols,
    architectureImpact: claim(p.architectureImpact, "architectureImpact"),
    implementationSteps,
    testPlan,
    configurationChanges,
    dependencyChanges: list(p.dependencyChanges).map((d, i) => {
      const field = `dependencyChanges[${i}]`;
      const ev = cleanEvidence(d.evidence, `${field}.evidence`);
      return { ...d, package: clean(d.package, `${field}.package`), reason: clean(d.reason, `${field}.reason`), certainty: settle(d.certainty, ev, field), evidence: ev };
    }),
    securityConsiderations: list(p.securityConsiderations).map((c, i) => claim(c, `securityConsiderations[${i}]`)),
    performanceConsiderations: list(p.performanceConsiderations).map((c, i) => claim(c, `performanceConsiderations[${i}]`)),
    risks: list(p.risks).map((r, i) => ({
      ...r,
      description: clean(r.description, `risks[${i}].description`),
      mitigation: clean(r.mitigation, `risks[${i}].mitigation`),
      evidence: cleanEvidence(r.evidence, `risks[${i}].evidence`),
    })),
    validationPlan: p.validationPlan.slice(0, PLAN_LIMITS.validationPlan).map((v, i) => clean(v, `validationPlan[${i}]`)),
    unknowns: list(p.unknowns).map((u, i) => clean(u, `unknowns[${i}]`)),
    confidence: clamp01(p.confidence),
  };

  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  const modelConfidence = clamp01(p.confidence);
  const confidence = Math.round(clamp01(modelConfidence - 0.1 * errors - 0.03 * warnings) * 100) / 100;
  return {
    plan: { ...plan, confidence },
    report: { status: errors > 0 ? "ERRORS" : warnings > 0 ? "WARNINGS" : "PASSED", issues, modelConfidence, confidence },
  };
}
