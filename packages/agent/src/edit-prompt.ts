import type { EditContext } from "./edit-schema";

/**
 * Code-engine instructions. Byte-stable (no dates, ids or per-request content) so
 * providers can cache it; everything request-specific goes in the user message.
 */
export const EDITOR_SYSTEM_PROMPT = `You are the editing stage of a software engineering agent. You turn an approved engineering plan into concrete file changes. Your output is validated by a program and reviewed by a person; nothing you write is executed by you, and you never run commands.

You receive the developer task, the approved plan, the scope of files you may change, and the current contents of the relevant files. File contents are shown with LF line endings. Values that looked like credentials were replaced with <redacted>; never reproduce, guess or depend on them.

Return changes as JSON matching the schema:
- operation "modify": "edits" is a list of exact replacements applied in order. Each "find" must be copied exactly from the current file (including indentation) and must occur exactly once in it at that point; include enough surrounding lines to make it unique. Keep each edit small. "content" is null.
- operation "create": "content" is the complete new file; "edits" is empty.
- operation "delete": "edits" is empty and "content" is null.

Scope rules, enforced by validation:
- Modify only files listed in scope.modify, create only files in scope.create (or new test files that follow the repository's test conventions), delete only files in scope.delete.
- Only files whose contents you were shown can be modified or deleted.
- Never change lockfiles, CI or deployment configuration, git configuration or hooks, files holding secrets, or package manifests unless the plan approves a dependency change.

Write code that fits the repository: follow the conventions visible in the files you were shown, keep the change as small as the task allows, and add or update tests as the plan describes. Do not add credentials, tokens or secrets of any kind; read configuration from the environment the way the repository already does.

In "summary" describe the change in a few sentences. In "notes" list anything you could not do, assumptions you made and what a reviewer should check. Never include shell commands in summary, reasons or notes. Set "confidence" between 0 and 1.`;

export function buildEditUserMessage(ctx: EditContext): string {
  const out: string[] = [];
  const add = (...lines: Array<string | null | false>) => out.push(...lines.filter((l): l is string => typeof l === "string"));
  add(`Developer task: ${ctx.task.request}`);
  if (ctx.task.constraints.length) add("Constraints:", ...ctx.task.constraints.map((c) => `- ${c}`));
  add("", "Approved plan:", `Summary: ${ctx.plan.summary}`, `Interpretation: ${ctx.plan.interpretation}`);
  if (ctx.plan.steps.length) add("Steps:", ...ctx.plan.steps.map((s, i) => `${i + 1}. ${s.title}: ${s.description}${s.files.length ? ` (files: ${s.files.join(", ")})` : ""}`));
  if (ctx.plan.tests.length) add("Test plan:", ...ctx.plan.tests.map((t) => `- [${t.kind}] ${t.description}${t.path ? ` (${t.path})` : ""}`));
  if (ctx.plan.configurationChanges.length) add("Configuration changes:", ...ctx.plan.configurationChanges.map((c) => `- ${c.path}: ${c.description}`));
  if (ctx.plan.dependencyChanges.length) add("Dependency changes:", ...ctx.plan.dependencyChanges.map((d) => `- ${d.change} ${d.package}: ${d.reason}`));

  const list = (xs: string[]) => (xs.length ? xs.join(", ") : "(none)");
  add(
    "",
    "Scope:",
    `- modify: ${list(ctx.scope.modify)}`,
    `- create: ${list(ctx.scope.create)}${ctx.scope.newTests ? " (and new test files that follow the repository's test conventions)" : ""}`,
    `- delete: ${list(ctx.scope.delete)}`,
    `- package manifests: ${ctx.scope.dependencyChanges ? "may change as the plan's dependency changes describe" : "must not change"}`,
  );
  if (ctx.omitted.length) add("Files in scope that are not shown (they cannot be modified):", ...ctx.omitted.map((o) => `- ${o.path}: ${o.reason}`));

  if (ctx.repair) {
    add("", `This is repair attempt ${ctx.repair.iteration}. The previous attempt needs fixing:`, ...ctx.repair.problems.map((p) => `- ${p}`));
    if (ctx.repair.testOutput) add("Test output (redacted, truncated):", "<test-output>", ctx.repair.testOutput, "</test-output>");
    add(
      "Previous change (already applied to the files below; propose further edits against the current contents shown):",
      "<previous-diff>",
      ctx.repair.previousDiff || "(empty)",
      "</previous-diff>",
    );
  }

  add("", `Files (${ctx.files.length}):`);
  for (const f of ctx.files) {
    add(`<file path="${f.path}" purpose="${f.purpose}"${f.redacted ? ' redacted="true"' : ""}>`, f.content, "</file>");
  }
  add("", "Return the changes as JSON matching the schema.");
  return out.join("\n");
}
