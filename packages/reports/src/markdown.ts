import type { CheckState, ReportData } from "./types";

/**
 * Markdown export of a report snapshot (deterministic). Repository-controlled text
 * (paths, titles, task text, model prose, test output) is escaped so the exported
 * file cannot carry HTML, links or formatting into whatever renders it later:
 * `<`, `>` and `&` become entities and Markdown syntax characters are backslash-
 * escaped; test output goes into fenced blocks whose fence is longer than any
 * backtick run in the output.
 */

const MD_SPECIAL = /[\\`*_{}[\]()#+\-.!|~]/g;

export function escapeMarkdown(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(MD_SPECIAL, (c) => `\\${c}`).replace(/\r?\n/g, " ");
}

function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(longest + 1);
  return `${f}text\n${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}\n${f}`;
}

const STATE: Record<CheckState, string> = {
  passed: "passed",
  failed: "FAILED",
  skipped: "skipped",
  pending: "pending",
  not_executed: "not executed",
  unavailable: "unavailable",
};

const e = escapeMarkdown;
const list = (items: string[], empty = "None.") => (items.length ? items.map((i) => `- ${i}`).join("\n") : empty);

export function renderMarkdown(r: ReportData, meta: { id: string; generatedAt: string }): string {
  const out: string[] = [];
  const h = (t: string) => out.push("", `## ${t}`, "");
  out.push(`# ${e(r.title)}`, "", `**Result:** ${e(r.outcome.replace(/_/g, " ").toLowerCase())} · **Report status:** ${e(r.status.toLowerCase())} · **Generated:** ${e(meta.generatedAt)} · **Report:** ${e(meta.id)} (schema v${r.version})`, "", e(r.summary));

  h("Overview");
  out.push("| Step | State | Detail |", "|---|---|---|", ...r.chain.map((s) => `| ${e(s.step)} | ${STATE[s.state]} | ${e(s.detail)} |`));

  h("Repository");
  out.push(list([`Name: ${e(r.repository.name)}`, `Source: ${e(r.repository.source)}`, `Branch: ${e(r.repository.branch ?? "default")}`, `Commit: ${e(r.repository.commitSha ?? "not recorded (upload or demo)")}`]));

  h("Analysis");
  const a = r.analysis;
  out.push(
    list([
      `Status: ${e(a.status.toLowerCase())}${a.error ? ` (${e(a.error)})` : ""}`,
      `Analyzer: ${e(a.analyzerVersion)}`,
      `Health: ${a.health ? `${a.health.score}/100 (${e(a.health.grade)})` : "unavailable"}`,
      `Findings: ${a.findings.total} (${Object.entries(a.findings.bySeverity).map(([k, v]) => `${e(k.toLowerCase())} ${v}`).join(", ") || "none"}); triaged ${a.findings.triaged}`,
      `Languages: ${a.overview?.languages.map((l) => e(l.language)).join(", ") || "unavailable"}`,
      `Frameworks: ${a.overview?.frameworks.map(e).join(", ") || "none detected"}`,
      `Dependencies: ${a.dependencies.total} (${a.dependencies.vulnerable} with known vulnerabilities; lookup ${e(a.dependencies.vulnerabilityScan ?? "unavailable")})`,
    ]),
  );
  if (a.findings.top.length) {
    out.push("", "| Severity | Finding | Location |", "|---|---|---|", ...a.findings.top.map((f) => `| ${e(f.severity)} | ${e(f.title)}${f.triaged ? " (triaged)" : ""} | ${f.path ? e(`${f.path}${f.line ? `:${f.line}` : ""}`) : "—"} |`));
  }

  if (r.plan) {
    const p = r.plan;
    h("Engineering plan");
    out.push(
      list([
        `Task: ${e(p.task.request)}`,
        `Status: ${e(p.status.toLowerCase())}${p.error ? ` (${e(p.error)})` : ""}`,
        `Validation: ${e(p.validationStatus ?? "unavailable")} (${p.validation.errors} errors, ${p.validation.warnings} warnings)`,
        `Confidence: ${p.confidence === null ? "unavailable" : `${Math.round(p.confidence * 100)}%`}`,
        `Approval: ${e(p.approval.state.replace(/_/g, " "))}${p.approval.approvedAt ? ` at ${e(p.approval.approvedAt)}` : ""}`,
        `Model: ${e(p.provider)} / ${e(p.model)}`,
      ]),
    );
    if (p.content) {
      out.push("", `**Summary:** ${e(p.content.summary)}`, "", "Affected files:", "", list(p.content.affectedFiles.map((f) => `${e(f.path)} (${e(f.change)}, ${e(f.certainty)}${f.flags.length ? `, flags: ${e(f.flags.join(", "))}` : ""})`)));
    }
  }

  if (r.run) {
    const run = r.run;
    h("Run");
    out.push(
      list([
        `Status: ${e(run.status.toLowerCase().replace(/_/g, " "))}${run.error ? ` (${e(run.error)})` : ""}`,
        `Iterations: ${run.usage.iterations} of ${run.budgets.maxIterations}; tokens ${run.usage.inputTokens + run.usage.outputTokens} of ${run.budgets.tokenBudget}`,
        `Review: ${e(run.review.state.replace(/_/g, " "))}`,
        `Test command approved: ${run.execution.approvedAt ? `${e(run.execution.testCommand ?? "unknown")} at ${e(run.execution.approvedAt)}` : "no"}`,
      ]),
    );
    if (run.summary) out.push("", `**Model summary:** ${e(run.summary)}`);
    h("Changes");
    out.push(`${run.changes.applied} applied (+${run.changes.additions} −${run.changes.deletions}), ${run.changes.rejected} rejected. Files changed:`, "", list(run.changes.filesChanged.map(e)));
    if (run.changes.items.length) {
      out.push("", "| Iteration | File | Operation | Status | +/− | Flags |", "|---|---|---|---|---|---|", ...run.changes.items.map((c) => `| ${c.iteration} | ${e(c.path)} | ${e(c.operation.toLowerCase())} | ${c.status.toLowerCase()} | +${c.additions} −${c.deletions} | ${e(c.flags.join(", ")) || "—"} |`));
    }
    h("Validation");
    out.push(`State: ${STATE[run.validation.state]}`, "", list(run.validation.blocked.map((b) => `${e(b.path)}: ${e(b.flags.join(", "))} — ${e(b.reason)}`), "No change was rejected."));
    h("Tests");
    out.push(`State: ${STATE[run.tests.state]} — ${e(run.tests.detail)}`);
    for (const x of run.tests.executions) {
      out.push("", `**#${x.iteration} ${e(x.kind.toLowerCase())}:** \`${x.command.replace(/`/g, "'")}\` — ${x.timedOut ? "timed out" : `exit ${x.exitCode ?? "unknown"}`}, network ${x.network ? "on" : "off"}`, "", fence(x.outputTail || "(no output)"));
    }
  }

  h("Security");
  const s = r.security;
  out.push(
    list([
      `Secrets detected: ${s.analysis.secrets} (values never shown)`,
      `Insecure patterns: ${s.analysis.insecurePatterns}`,
      `Dependencies with known vulnerabilities: ${s.analysis.vulnerableDependencies}`,
      `Committed environment files: ${s.analysis.committedEnvFiles.map(e).join(", ") || "none"}`,
      ...(s.run ? [`Edits blocked for security reasons: ${s.run.blockedForSecurity.length}`, `Sandbox used: ${s.run.sandbox.used ? "yes" : "no"}`] : []),
    ]),
    "",
    list(s.notes.map(e)),
  );

  h("Errors and warnings");
  out.push(list([...r.issues.errors.map((i) => `Error (${e(i.source)}): ${e(i.message)}`), ...r.issues.warnings.map((i) => `Warning (${e(i.source)}): ${e(i.message)}`)]));

  h("Limitations");
  out.push(list(r.limitations.map(e)));

  h("Timeline");
  out.push(list(r.timeline.map((t) => `${e(t.at)} · ${e(t.source)} · ${e(t.event)}${t.actor ? ` (${e(t.actor)})` : ""}`)));
  return `${out.join("\n").trim()}\n`;
}
