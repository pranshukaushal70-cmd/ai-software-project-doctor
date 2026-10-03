import { inspectSource, type SourceInspection } from "@pd/analyzer/inspect";
import type { EditIssue, ProposedChange } from "./edit-validate";

/**
 * Re-inspects every accepted change before and after with the analyzer's own
 * rules (tree-sitter parse, insecure-pattern and secret rules), in memory. A change
 * is rejected when it adds syntax errors or introduces a security finding the file
 * did not have before; pre-existing problems are not held against it. Separate
 * from edit-validate.ts (exported as `@pd/agent/checks`) because it loads the
 * tree-sitter parser, which only the worker needs.
 */
export async function checkChanges(changes: ProposedChange[]): Promise<EditIssue[]> {
  const issues: EditIssue[] = [];
  for (const change of changes) {
    if (change.status !== "accepted" || change.after === null) continue;
    const after = await inspectSource(change.path, change.after);
    const before: SourceInspection = change.before === null ? { parsed: false, syntaxErrors: 0, timedOut: false, findings: [] } : await inspectSource(change.path, change.before);
    const reject = (code: EditIssue["code"], message: string) => {
      issues.push({ severity: "error", code, path: change.path, field: "after", message });
      change.flags.push(code);
      change.status = "rejected";
    };
    if (after.syntaxErrors > before.syntaxErrors) {
      reject("syntax-error", `The changed ${change.path} does not parse: ${after.syntaxErrors - before.syntaxErrors} new syntax error(s).`);
    }
    // Findings are compared by rule and content-based key, as a multiset, so moved lines are not "new".
    const existing = new Map<string, number>();
    for (const f of before.findings) existing.set(`${f.ruleId}\0${f.key}`, (existing.get(`${f.ruleId}\0${f.key}`) ?? 0) + 1);
    for (const f of after.findings) {
      const id = `${f.ruleId}\0${f.key}`;
      const left = existing.get(id) ?? 0;
      if (left > 0) existing.set(id, left - 1);
      else reject("insecure-change", `The change introduces "${f.title}" (${f.severity}) at line ${f.line} of ${change.path}.`);
    }
  }
  return issues;
}
