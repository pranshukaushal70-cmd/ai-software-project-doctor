// The dependency-free redaction module, not "@pd/analyzer/metrics" (which loads the tree-sitter parser).
import { redactSecrets } from "@pd/analyzer/evidence";
import { EDIT_LIMITS, isSecretPath } from "./edit-policy";
import type { ContextFile, EditContext, EditScope, RepairFeedback } from "./edit-schema";
import { isRepoPath, type RepositoryFacts, type ValidatedPlan } from "./validate";

/**
 * Builds what the model sees for one edit request: the task, the approved plan,
 * the scope and the contents of the files it concerns. This is the only place file
 * contents leave the repository, so it is bounded and filtered: only files the plan
 * names, never secret files, never binary files, at most EDIT_LIMITS bytes, and
 * credential-like values are redacted. The unredacted originals are returned
 * separately and never sent: edits are applied to them, not to the redacted copy.
 */

export interface EditContextInput {
  task: { request: string; constraints: string[] };
  plan: ValidatedPlan;
  scope: EditScope;
  facts: RepositoryFacts;
  /** Reads a repository file from the run's workspace; null when it cannot be read. */
  readFile(path: string): Promise<string | null>;
  repair?: RepairFeedback | null;
}

export interface BuiltEditContext {
  context: EditContext;
  /** Original contents of the files in the context, keyed by path. Never sent to a provider. */
  originals: Map<string, string>;
}

const BINARY = /\u0000/;

export async function buildEditContext(input: EditContextInput): Promise<BuiltEditContext> {
  const { plan, scope, facts } = input;
  // Files to show, most important first: the limits cut from the end.
  const wanted = new Map<string, ContextFile["purpose"]>();
  const want = (path: string, purpose: ContextFile["purpose"]) => {
    if (!wanted.has(path) && isRepoPath(path) && facts.files.has(path)) wanted.set(path, purpose);
  };
  for (const p of scope.modify) want(p, facts.files.get(p) === "TEST" ? "test" : "modify");
  for (const p of scope.delete) want(p, "delete");
  for (const f of plan.affectedFiles) if (f.change === "review" && !f.flags.includes("nonexistent-file")) want(f.path, "reference");
  for (const s of plan.affectedSymbols) if (s.change === "review") want(s.path, "reference");

  const files: ContextFile[] = [];
  const omitted: EditContext["omitted"] = [];
  const originals = new Map<string, string>();
  let bytes = 0;
  let truncated = false;
  for (const [path, purpose] of wanted) {
    if (isSecretPath(path, facts.files.get(path))) {
      omitted.push({ path, reason: "holds secrets; never shown" });
      continue;
    }
    if (files.length >= EDIT_LIMITS.contextFiles) {
      omitted.push({ path, reason: "context file limit reached" });
      truncated = true;
      continue;
    }
    const original = await input.readFile(path);
    if (original === null) {
      omitted.push({ path, reason: "could not be read" });
      continue;
    }
    const size = Buffer.byteLength(original, "utf8");
    if (BINARY.test(original)) {
      omitted.push({ path, reason: "binary content" });
      continue;
    }
    if (size > EDIT_LIMITS.contextFileBytes) {
      omitted.push({ path, reason: `larger than ${EDIT_LIMITS.contextFileBytes / 1024} KB` });
      continue;
    }
    if (bytes + size > EDIT_LIMITS.contextBytes) {
      omitted.push({ path, reason: "context size limit reached" });
      truncated = true;
      continue;
    }
    const normalized = toModelText(original);
    const redacted = redactSecrets(normalized);
    files.push({ path, purpose, content: redacted, redacted: redacted !== normalized });
    originals.set(path, original);
    bytes += size;
  }

  const context: EditContext = {
    task: { request: input.task.request, constraints: input.task.constraints },
    plan: {
      summary: plan.taskSummary,
      interpretation: plan.interpretation,
      steps: plan.implementationSteps.map((s) => ({ title: s.title, description: s.description, files: s.files })),
      tests: plan.testPlan.map((t) => ({ description: t.description, path: t.path, kind: t.kind })),
      dependencyChanges: plan.dependencyChanges.filter((d) => d.change !== "none").map((d) => ({ package: d.package, change: d.change, reason: d.reason })),
      configurationChanges: plan.configurationChanges.map((c) => ({ path: c.path, description: c.description })),
    },
    scope,
    files,
    omitted,
    repair: input.repair ?? null,
    stats: { files: files.length, bytes, truncated },
  };
  return { context, originals };
}

/** What the model sees of a file: no byte-order mark, LF line endings. Edits are mapped back to the original's conventions. */
export function toModelText(text: string): string {
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, "\n");
}
