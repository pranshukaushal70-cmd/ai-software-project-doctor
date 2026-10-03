import { fileRole, kindOfPath } from "@pd/analyzer/classify";
// The dependency-free redaction module, not "@pd/analyzer/metrics" (which loads the tree-sitter parser).
import { redactSecrets } from "@pd/analyzer/evidence";
import { unifiedDiff } from "./diff";
import { toModelText } from "./edit-context";
import { EDIT_LIMITS, forbiddenReason } from "./edit-policy";
import { EditOutputSchema, type EditContext, type EditOperation } from "./edit-schema";
import { clamp01, COMMAND, isRepoPath, REMOVED_COMMAND, TEST_PATH, type RepositoryFacts } from "./validate";

/**
 * Deterministic validation of proposed edits. Model output is untrusted: it is
 * parsed against the schema, every change is checked against the approved scope and
 * the never-editable paths, every `find` must match the original file exactly
 * once, and limits apply. Edits are applied in memory to the unredacted originals
 * (never to the copy the model saw) and each accepted change gets a unified diff.
 * Rejected changes are kept with their flags so the user sees what was refused.
 * Nothing here touches the filesystem; the caller writes accepted changes into the
 * run's isolated workspace.
 */

export type EditIssueCode =
  | "schema"
  | "invalid-path"
  | "forbidden-path"
  | "out-of-scope"
  | "unlisted-test"
  | "dependency-change-not-approved"
  | "not-in-context"
  | "file-exists"
  | "duplicate-change"
  | "malformed-change"
  | "anchor-empty"
  | "anchor-not-found"
  | "anchor-ambiguous"
  | "touches-redacted"
  | "mixed-line-endings"
  | "binary-content"
  | "secret"
  | "no-op"
  | "too-large"
  | "too-many-changes"
  | "too-many-lines"
  | "command"
  | "syntax-error"
  | "insecure-change";

export interface EditIssue {
  severity: "error" | "warning";
  code: EditIssueCode;
  /** The change's path, when the issue concerns one change. */
  path: string | null;
  field: string;
  message: string;
}

export interface ProposedChange {
  path: string;
  operation: EditOperation;
  reason: string;
  status: "accepted" | "rejected";
  /** Issue codes concerning this change. */
  flags: EditIssueCode[];
  /** Original and resulting file contents (null: does not exist before / after). Never sent anywhere. */
  before: string | null;
  after: string | null;
  diff: string;
  additions: number;
  deletions: number;
}

export type EditValidationStatus = "PASSED" | "WARNINGS" | "ERRORS" | "REJECTED";

export interface EditReport {
  status: EditValidationStatus;
  issues: EditIssue[];
  accepted: number;
  rejected: number;
  modelConfidence: number;
  /** The model's confidence lowered per problem, as for plans. */
  confidence: number;
}

export interface ValidatedEdits {
  summary: string;
  notes: string[];
  changes: ProposedChange[];
  report: EditReport;
}

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const REDACTION_MARKER = "<redacted>";

export function validateEdits(raw: unknown, context: EditContext, originals: ReadonlyMap<string, string>, facts: RepositoryFacts): ValidatedEdits {
  const parsed = EditOutputSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: EditIssue[] = parsed.error.issues.slice(0, 20).map((i) => ({
      severity: "error",
      code: "schema",
      path: null,
      field: i.path.join(".") || "(root)",
      message: `Output does not match the edit schema: ${i.message}`,
    }));
    return { summary: "", notes: [], changes: [], report: { status: "REJECTED", issues, accepted: 0, rejected: 0, modelConfidence: 0, confidence: 0 } };
  }

  const issues: EditIssue[] = [];
  const issue = (severity: EditIssue["severity"], code: EditIssueCode, path: string | null, field: string, message: string) => {
    issues.push({ severity, code, path, field, message });
    return code;
  };
  /** Prose from the model: bounded, credentials redacted, commands removed (as for plans). */
  const prose = (text: string, field: string): string => {
    let t = text.length > EDIT_LIMITS.text ? `${text.slice(0, EDIT_LIMITS.text - 1)}…` : text;
    const redacted = redactSecrets(t);
    if (redacted !== t) {
      issue("error", "secret", null, field, "Text contained a value that looks like a credential; it was redacted.");
      t = redacted;
    }
    if (COMMAND.test(t)) {
      issue("warning", "command", null, field, "Text contained a shell command; it was removed. The code engine never runs commands a model suggests.");
      t = REMOVED_COMMAND;
    }
    return t;
  };

  const { scope } = context;
  const inScope = { modify: new Set(scope.modify), create: new Set(scope.create), delete: new Set(scope.delete) };
  const seen = new Set<string>();
  const changes: ProposedChange[] = [];
  let changedLines = 0;
  let accepted = 0;

  parsed.data.changes.forEach((c, i) => {
    const field = `changes[${i}]`;
    const flags: EditIssueCode[] = [];
    const reject = (code: EditIssueCode, message: string, sub = "path") => flags.push(issue("error", code, c.path.slice(0, 300), `${field}.${sub}`, message));
    const change: ProposedChange = {
      path: c.path,
      operation: c.operation,
      reason: prose(c.reason, `${field}.reason`),
      status: "rejected",
      flags,
      before: null,
      after: null,
      diff: "",
      additions: 0,
      deletions: 0,
    };
    changes.push(change);

    if (!isRepoPath(c.path) || c.path.split("/").some((s) => s === "." || s === "")) {
      change.path = "[invalid path removed]";
      reject("invalid-path", "Not a path inside the repository.");
      return;
    }
    if (seen.has(c.path)) return void reject("duplicate-change", `${c.path} is changed more than once; only the first change is considered.`);
    seen.add(c.path);

    const kind = facts.files.get(c.path) ?? kindOfPath(c.path);
    const forbidden = forbiddenReason(c.path, kind);
    if (forbidden) return void reject("forbidden-path", `${c.path} is ${forbidden}; the code engine never changes it.`);

    if (c.operation === "create" && (facts.files.has(c.path) || originals.has(c.path))) return void reject("file-exists", `${c.path} already exists; it can only be modified.`);

    // Scope: the approved plan decides what may change.
    if (c.operation === "modify" && !inScope.modify.has(c.path)) return void reject("out-of-scope", `${c.path} is not a file the approved plan modifies.`);
    if (c.operation === "delete" && !inScope.delete.has(c.path)) return void reject("out-of-scope", `${c.path} is not a file the approved plan deletes.`);
    if (c.operation === "create" && !inScope.create.has(c.path)) {
      if (scope.newTests && kind === "TEST" && TEST_PATH.test(c.path)) {
        flags.push(issue("warning", "unlisted-test", c.path, `${field}.path`, `${c.path} is a new test the plan did not name; accepted because it follows test conventions.`));
      } else return void reject("out-of-scope", `${c.path} is not a file the approved plan creates.`);
    }
    if (c.operation !== "delete" && fileRole(c.path, kind) === "manifest" && !scope.dependencyChanges) {
      return void reject("dependency-change-not-approved", `${c.path} is a package manifest and the approved plan makes no dependency change.`);
    }

    // Shape of each operation.
    if (c.operation === "create" && (c.content === null || c.edits.length > 0)) return void reject("malformed-change", "A new file needs its full content and no edits.", "content");
    if (c.operation === "modify" && (c.edits.length === 0 || c.content !== null)) return void reject("malformed-change", "A modification needs edits and no full content.", "edits");
    if (c.operation === "delete" && (c.edits.length > 0 || c.content !== null)) return void reject("malformed-change", "A deletion has no edits or content.", "edits");

    if (c.operation === "create") {
      const text = c.content!;
      if (!checkNewText(text, `${field}.content`)) return;
      change.after = text;
    } else {
      const original = originals.get(c.path);
      if (original === undefined) return void reject("not-in-context", `${c.path} was not shown to the model (see omitted files), so it cannot be changed.`);
      change.before = original;
      if (c.operation === "delete") change.after = null;
      else {
        const applied = applyEdits(original, c.edits, field);
        if (applied === null) return;
        change.after = applied;
      }
    }

    if (change.after !== null && Buffer.byteLength(change.after, "utf8") > EDIT_LIMITS.resultFileBytes) {
      return void reject("too-large", `The resulting file is larger than ${EDIT_LIMITS.resultFileBytes / 1024} KB.`);
    }
    if (change.before === change.after) {
      flags.push(issue("warning", "no-op", c.path, field, `The change leaves ${c.path} unchanged; it was dropped.`));
      return;
    }
    const d = unifiedDiff(c.path, change.before, change.after);
    if (accepted >= EDIT_LIMITS.changes) return void reject("too-many-changes", `More than ${EDIT_LIMITS.changes} files changed; the rest were rejected.`);
    if (changedLines + d.additions + d.deletions > EDIT_LIMITS.changedLines) {
      return void reject("too-many-lines", `The change would exceed ${EDIT_LIMITS.changedLines} changed lines in total.`);
    }
    changedLines += d.additions + d.deletions;
    accepted++;
    Object.assign(change, { status: "accepted", diff: d.diff, additions: d.additions, deletions: d.deletions });

    function checkNewText(text: string, sub: string): boolean {
      if (CONTROL.test(text)) {
        reject("binary-content", "Contains control characters; only text changes are accepted.", sub.slice(field.length + 1));
        return false;
      }
      if (text.includes(REDACTION_MARKER)) {
        reject("touches-redacted", "Writes a redaction marker: it depends on a value the model could not see.", sub.slice(field.length + 1));
        return false;
      }
      if (redactSecrets(text) !== text) {
        reject("secret", "Adds a value that looks like a credential.", sub.slice(field.length + 1));
        return false;
      }
      return true;
    }

    /** Applies the edits to the original, in its own conventions (BOM, CRLF). Null when an edit cannot be applied. */
    function applyEdits(original: string, edits: Array<{ find: string; replace: string }>, f: string): string | null {
      const bom = original.charCodeAt(0) === 0xfeff;
      const body = bom ? original.slice(1) : original;
      const crlf = (body.match(/\r\n/g) ?? []).length;
      const lf = (body.match(/\n/g) ?? []).length;
      if (crlf > 0 && crlf < lf) {
        reject("mixed-line-endings", `${c.path} mixes CRLF and LF line endings; it cannot be edited safely.`);
        return null;
      }
      let text = toModelText(original);
      for (let j = 0; j < edits.length; j++) {
        const e = edits[j]!;
        const find = e.find.replace(/\r\n/g, "\n");
        const replace = e.replace.replace(/\r\n/g, "\n");
        const sub = `${f}.edits[${j}]`;
        if (find.length === 0) {
          reject("anchor-empty", "An edit has an empty `find`.", sub.slice(field.length + 1));
          return null;
        }
        if (find.includes(REDACTION_MARKER)) {
          reject("touches-redacted", "An edit's `find` includes a redacted value, which does not occur in the file.", sub.slice(field.length + 1));
          return null;
        }
        if (!checkNewText(replace, `${sub}.replace`)) return null;
        const at = text.indexOf(find);
        if (at < 0) {
          reject("anchor-not-found", `Edit ${j + 1}: the text to replace does not occur in ${c.path}.`, sub.slice(field.length + 1));
          return null;
        }
        if (text.indexOf(find, at + 1) >= 0) {
          reject("anchor-ambiguous", `Edit ${j + 1}: the text to replace occurs more than once in ${c.path}.`, sub.slice(field.length + 1));
          return null;
        }
        text = text.slice(0, at) + replace + text.slice(at + find.length);
      }
      if (crlf > 0) text = text.replace(/\n/g, "\r\n");
      return bom ? String.fromCharCode(0xfeff) + text : text;
    }
  });

  const summary = prose(parsed.data.summary, "summary");
  const notes = parsed.data.notes.slice(0, EDIT_LIMITS.notes).map((n, i) => prose(n, `notes[${i}]`));
  return { summary, notes, changes, report: buildReport(issues, changes, parsed.data.confidence) };
}

export function buildReport(issues: EditIssue[], changes: ProposedChange[], modelConfidence: number): EditReport {
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  const accepted = changes.filter((c) => c.status === "accepted").length;
  const m = clamp01(modelConfidence);
  return {
    status: errors > 0 ? "ERRORS" : warnings > 0 ? "WARNINGS" : "PASSED",
    issues,
    accepted,
    rejected: changes.length - accepted,
    modelConfidence: m,
    confidence: Math.round(clamp01(m - 0.1 * errors - 0.03 * warnings) * 100) / 100,
  };
}
