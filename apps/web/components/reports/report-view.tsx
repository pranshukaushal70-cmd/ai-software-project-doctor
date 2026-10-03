import { AlertTriangle, Download } from "lucide-react";
import type { ReportData } from "@pd/reports";
import type { ReportOutcomeName, ReportStatusName, ReportTypeName } from "@pd/shared/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn, formatDate } from "@/lib/utils";
import { GenerateReportButton } from "./generate-report-button";
import { CHECK, OUTCOME, REPORT_STATUS, REPORT_TYPE, STEP_LABEL } from "./labels";
import { RunDiff } from "./run-diff";

/**
 * One report snapshot. Everything shown comes from the stored snapshot (what was
 * recorded when it was generated); only diffs are loaded from the run on demand.
 * Repository-controlled text (paths, titles, task text, model prose, test output)
 * is rendered as text by React, never as HTML or Markdown.
 */

export interface ReportDto {
  id: string;
  type: ReportTypeName;
  status: ReportStatusName;
  outcome: ReportOutcomeName;
  version: number;
  title: string;
  summary: string;
  errorCount: number;
  warningCount: number;
  analysisId: string;
  planId: string | null;
  runId: string | null;
  generatedAt: string;
  data: ReportData;
}

const SUBJECT = (r: ReportDto) => (r.type === "RUN" ? r.runId! : r.type === "PLAN" ? r.planId! : r.analysisId);
const ms = (n: number | null) => (n === null ? "—" : n < 1000 ? `${n} ms` : n < 120_000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n / 60_000)} min`);
const when = (d: string | null) => (d ? formatDate(d) : "—");

function Check({ state }: { state: string }) {
  const c = CHECK[state] ?? { label: state, tone: "neutral" as const };
  return <Badge tone={c.tone}>{c.label}</Badge>;
}

function Section({ title, count, open = true, children }: { title: string; count?: number | string; open?: boolean; children: React.ReactNode }) {
  return (
    <details open={open} className="group rounded-xl border bg-card shadow-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-base font-semibold">
        <span className="text-muted-foreground transition-transform group-open:rotate-90" aria-hidden>
          ›
        </span>
        {title}
        {count !== undefined && <span className="text-sm font-normal text-muted-foreground">{count}</span>}
      </summary>
      <div className="min-w-0 space-y-3 border-t px-4 py-3 text-sm">{children}</div>
    </details>
  );
}

function Facts({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[12rem_1fr]">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-muted-foreground">{children}</p>;
const Code = ({ children }: { children: React.ReactNode }) => <code className="break-all font-mono text-xs">{children}</code>;
const join = (xs: string[], empty = "none detected") => (xs.length ? xs.join(", ") : <span className="text-muted-foreground">{empty}</span>);

export function ReportView({ report, interactive = true }: { report: ReportDto; interactive?: boolean }) {
  const d = report.data;
  const outcome = OUTCOME[report.outcome];
  const status = REPORT_STATUS[report.status];
  const a = d.analysis;
  const run = d.run;
  const plan = d.plan;

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------------- executive summary */}
      <Card>
        <CardContent className="space-y-4 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={outcome.tone}>{outcome.label}</Badge>
            <Badge tone={status.tone} title={status.help}>
              Report {status.label.toLowerCase()}
            </Badge>
            <Badge>{REPORT_TYPE[report.type]} report</Badge>
            <span className="text-xs text-muted-foreground">
              Generated {when(report.generatedAt)} · schema v{report.version}
            </span>
          </div>
          <h1 className="text-xl font-semibold tracking-tight break-words">{report.title}</h1>
          <p className="break-words">{report.summary}</p>
          {report.status === "PARTIAL" && (
            <p className="flex items-start gap-2 text-sm text-sev-medium">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {status.help}
            </p>
          )}
          <ol className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3" aria-label="Project Doctor steps">
            {d.chain.map((s, i) => (
              <li key={s.step} className="flex min-w-0 items-start gap-2 rounded-md border px-2.5 py-1.5">
                <span className="w-4 shrink-0 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{STEP_LABEL[s.step] ?? s.step}</span>
                    <Check state={s.state} />
                  </span>
                  <span className="block truncate text-xs text-muted-foreground" title={s.detail}>
                    {s.detail}
                  </span>
                </span>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild size="sm" variant="outline">
              <a href={`/api/reports/${report.id}/export?format=markdown`} download>
                <Download className="size-4" /> Markdown
              </a>
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href={`/api/reports/${report.id}/export?format=json`} download>
                <Download className="size-4" /> JSON
              </a>
            </Button>
            {interactive && <GenerateReportButton type={report.type} subjectId={SUBJECT(report)} label="Generate again" />}
            <span className="text-xs text-muted-foreground">A report never changes; generating again creates a new snapshot only if something changed.</span>
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- repository */}
      <Section title="Repository">
        <Facts
          items={[
            ["Name", d.repository.name],
            ["Source", d.repository.source],
            ["URL", d.repository.url ?? "—"],
            ["Branch", d.repository.branch ?? "default"],
            ["Commit", d.repository.commitSha ? <Code key="c">{d.repository.commitSha}</Code> : "not recorded (uploads and the demo have none)"],
          ]}
        />
      </Section>

      {/* ---------------------------------------------------------------- analysis */}
      <Section title="Analysis" count={`${a.findings.total} findings`}>
        <Facts
          items={[
            ["Status", <span key="s">{a.status.toLowerCase()}{a.error ? ` — ${a.error}` : ""}</span>],
            ["Health score", a.health ? `${a.health.score}/100 (grade ${a.health.grade})` : "unavailable"],
            ["Analyzed", `${when(a.startedAt)} → ${when(a.finishedAt)} (${ms(a.durationMs)})`],
            ["Analyzer", `v${a.analyzerVersion}`],
            ["Files / lines", a.overview ? `${a.overview.files ?? "—"} / ${a.overview.lines ?? "—"}` : "unavailable"],
            ["Languages", a.overview ? join(a.overview.languages.map((l) => `${l.language} (${l.files})`)) : "unavailable"],
            ["Frameworks", a.overview ? join(a.overview.frameworks) : "unavailable"],
            ["Test frameworks", a.overview ? join(a.overview.testFrameworks) : "unavailable"],
            ["Package managers", a.overview ? join(a.overview.packageManagers) : "unavailable"],
            ["Entry points", a.overview ? join(a.overview.entryPoints) : "unavailable"],
            ["Source / test dirs", a.overview ? join([...a.overview.sourceDirs, ...a.overview.testDirs].map((x) => `${x.path} (${x.files})`)) : "unavailable"],
            ["Dependencies", `${a.dependencies.total} (${a.dependencies.vulnerable} with known vulnerabilities; lookup ${a.dependencies.vulnerabilityScan ?? "unavailable"})`],
            ["Findings by severity", Object.keys(a.findings.bySeverity).length ? Object.entries(a.findings.bySeverity).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(", ") : "none"],
            ["Triaged", `${a.findings.triaged} (marked expected or ignored)`],
          ]}
        />
        {a.findings.top.length > 0 && (
          <ul className="divide-y">
            {a.findings.top.map((f, i) => (
              <li key={i} className="flex min-w-0 flex-wrap items-center gap-2 py-1.5">
                <Badge tone={f.severity === "CRITICAL" || f.severity === "HIGH" ? "critical" : f.severity === "MEDIUM" ? "medium" : "neutral"}>{f.severity}</Badge>
                <span className="min-w-0 flex-1 break-words">{f.title}</span>
                {f.path && <Code>{`${f.path}${f.line ? `:${f.line}` : ""}`}</Code>}
                {f.triaged && <Badge>triaged</Badge>}
              </li>
            ))}
          </ul>
        )}
        {a.findings.top.length < a.findings.total && (
          <p className="text-xs text-muted-foreground">
            {a.findings.top.length} most severe of {a.findings.total} shown; the analysis keeps all of them.
          </p>
        )}
      </Section>

      {/* ---------------------------------------------------------------- plan */}
      {plan && (
        <Section title="Engineering plan">
          <Facts
            items={[
              ["Task", plan.task.request],
              ["Status", <span key="s">{plan.status.toLowerCase()}{plan.error ? ` — ${plan.error}` : ""}</span>],
              ["Validation", `${plan.validationStatus ?? "unavailable"} (${plan.validation.errors} errors, ${plan.validation.warnings} warnings)`],
              ["Confidence", plan.confidence === null ? "unavailable" : `${Math.round(plan.confidence * 100)}%`],
              ["Model", `${plan.provider} · ${plan.model}`],
              ["Created", when(plan.createdAt)],
            ]}
          />
          {plan.content ? (
            <>
              <p className="break-words">
                <span className="text-muted-foreground">Summary: </span>
                {plan.content.summary}
              </p>
              <p className="break-words text-muted-foreground">{plan.content.interpretation}</p>
              <ul className="space-y-1">
                {plan.content.affectedFiles.map((f, i) => (
                  <li key={i} className="flex min-w-0 flex-wrap items-center gap-2">
                    <Code>{f.path}</Code>
                    <Badge>{f.change}</Badge>
                    <Badge tone={f.certainty === "VERIFIED" ? "ok" : f.certainty === "UNKNOWN" ? "neutral" : "medium"}>{f.certainty}</Badge>
                    {f.flags.map((fl) => (
                      <Badge key={fl} tone="critical">
                        {fl}
                      </Badge>
                    ))}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <Empty>The plan has no content: it did not complete.</Empty>
          )}
          {plan.validation.issues.length > 0 && (
            <ul className="space-y-1">
              {plan.validation.issues.map((i, n) => (
                <li key={n} className="flex min-w-0 flex-wrap items-start gap-2">
                  <Badge tone={i.severity === "error" ? "critical" : "medium"}>{i.severity}</Badge>
                  <span className="min-w-0 flex-1 break-words">{i.message}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {/* ---------------------------------------------------------------- approval */}
      {plan && (
        <Section title="Approval">
          <Facts
            items={[
              ["Plan approval", <span key="p">{plan.approval.state.replace(/_/g, " ")}{plan.approval.approvedAt ? ` — ${when(plan.approval.approvedAt)}` : ""}</span>],
              ...(run
                ? ([
                    ["Test command approval", run.execution.approvedAt ? `approved ${when(run.execution.approvedAt)}` : "not given"],
                    ["Install step approval", run.execution.installApproved ? "approved (network access)" : "not approved"],
                    ["Review", run.review.state.replace(/_/g, " ")],
                  ] as Array<[string, React.ReactNode]>)
                : []),
            ]}
          />
        </Section>
      )}

      {/* ---------------------------------------------------------------- run */}
      {run && (
        <Section title="Execution / run">
          <Facts
            items={[
              ["Status", <span key="s">{run.status.toLowerCase().replace(/_/g, " ")}{run.error ? ` — ${run.error}` : ""}</span>],
              ["Timing", `${when(run.startedAt ?? run.createdAt)} → ${when(run.finishedAt)} (${ms(run.durationMs)})`],
              ["Iterations", `${run.usage.iterations} of ${run.budgets.maxIterations}`],
              ["Tokens", `${run.usage.inputTokens + run.usage.outputTokens} of ${run.budgets.tokenBudget}`],
              ["Model", `${run.provider} · ${run.model}`],
              ["Commit", run.commitSha ? <Code key="c">{run.commitSha}</Code> : "—"],
              ["Cancellation", run.cancelRequestedAt ? `requested ${when(run.cancelRequestedAt)}` : "none"],
            ]}
          />
          {run.summary && (
            <p className="break-words">
              <span className="text-muted-foreground">Model summary: </span>
              {run.summary}
            </p>
          )}
          {run.notes.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
              {run.notes.map((n, i) => (
                <li key={i} className="break-words">
                  {n}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {/* ---------------------------------------------------------------- changes */}
      {run && (
        <Section title="Changes" count={`${run.changes.filesChanged.length} files · +${run.changes.additions} −${run.changes.deletions}`} open={run.changes.items.length <= 20}>
          {run.changes.items.length === 0 ? (
            <Empty>No change was proposed.</Empty>
          ) : (
            <ul className="divide-y">
              {run.changes.items.map((c, i) => (
                <li key={i} className="min-w-0 space-y-1 py-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge>#{c.iteration}</Badge>
                    <code className={cn("min-w-0 break-all font-mono text-xs", c.status === "REJECTED" && "line-through decoration-sev-critical")}>{c.path}</code>
                    <Badge>{c.operation.toLowerCase()}</Badge>
                    <Badge tone={c.status === "APPLIED" ? "ok" : "critical"}>{c.status === "APPLIED" ? "applied" : "rejected"}</Badge>
                    {c.status === "APPLIED" && (
                      <span className="text-xs">
                        <span className="text-ok">+{c.additions}</span> <span className="text-sev-critical">−{c.deletions}</span>
                      </span>
                    )}
                    {c.flags.map((f) => (
                      <Badge key={f} tone="critical">
                        {f}
                      </Badge>
                    ))}
                  </div>
                  <p className="break-words text-muted-foreground">{c.reason}</p>
                  {c.status === "APPLIED" && interactive && <RunDiff runId={run.id} iteration={c.iteration} path={c.path} />}
                </li>
              ))}
            </ul>
          )}
          {run.changes.truncated && <p className="text-xs text-muted-foreground">The list of changes is truncated.</p>}
        </Section>
      )}

      {/* ---------------------------------------------------------------- validation */}
      {run && (
        <Section title="Validation">
          <div className="flex flex-wrap items-center gap-2">
            <Check state={run.validation.state} />
            <span>
              {run.changes.applied} accepted, {run.changes.rejected} rejected
            </span>
          </div>
          {run.validation.iterations.length > 0 && (
            <ul className="text-muted-foreground">
              {run.validation.iterations.map((it) => (
                <li key={it.iteration}>
                  Iteration {it.iteration}: {it.accepted} accepted, {it.rejected} rejected
                </li>
              ))}
            </ul>
          )}
          {run.validation.blocked.length === 0 ? (
            <Empty>No change was rejected.</Empty>
          ) : (
            <ul className="space-y-1">
              {run.validation.blocked.map((b, i) => (
                <li key={i} className="flex min-w-0 flex-wrap items-start gap-2">
                  <Code>{b.path}</Code>
                  {b.flags.map((f) => (
                    <Badge key={f} tone="critical">
                      {f}
                    </Badge>
                  ))}
                  <span className="min-w-0 flex-1 break-words text-muted-foreground">{b.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {/* ---------------------------------------------------------------- tests */}
      {run && (
        <Section title="Tests">
          <div className="flex flex-wrap items-center gap-2">
            <Check state={run.tests.state} />
            <span className="min-w-0 break-words">{run.tests.detail}</span>
          </div>
          {run.execution.testCommand && (
            <p className="text-muted-foreground">
              Command <Code>{run.execution.testCommand}</Code>
              {run.execution.image && (
                <>
                  {" "}
                  on <Code>{run.execution.image}</Code>
                </>
              )}
            </p>
          )}
          {run.tests.executions.length === 0 ? (
            <Empty>No command ran in the sandbox.</Empty>
          ) : (
            run.tests.executions.map((x, i) => (
              <details key={i} className="min-w-0 rounded-md border p-2" open={i === run.tests.executions.length - 1}>
                <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                  <Badge>#{x.iteration}</Badge>
                  <Badge>{x.kind === "INSTALL" ? "install" : "tests"}</Badge>
                  <Badge tone={x.exitCode === 0 && !x.timedOut ? "ok" : "critical"}>{x.timedOut ? "timed out" : `exit ${x.exitCode ?? "?"}`}</Badge>
                  <Code>{x.command}</Code>
                  <Badge tone={x.network ? "medium" : "neutral"}>{x.network ? "network" : "no network"}</Badge>
                  <span className="text-xs text-muted-foreground">{ms(x.durationMs)}</span>
                </summary>
                <pre className="mt-2 max-h-80 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px] whitespace-pre-wrap break-words">{x.outputTail || "(no output)"}</pre>
                {x.outputTruncated && <p className="text-xs text-muted-foreground">Only the end of the output is kept in the report.</p>}
              </details>
            ))
          )}
        </Section>
      )}

      {/* ---------------------------------------------------------------- security */}
      <Section title="Security" count={`${d.security.analysis.secrets} secrets · ${d.security.analysis.insecurePatterns} insecure patterns`}>
        <Facts
          items={[
            ["Secrets detected", `${d.security.analysis.secrets} (values are never shown)`],
            ["Insecure patterns", String(d.security.analysis.insecurePatterns)],
            ["Vulnerable dependencies", String(d.security.analysis.vulnerableDependencies)],
            ["Committed environment files", join(d.security.analysis.committedEnvFiles, "none")],
            ...(d.security.run
              ? ([
                  ["Edits blocked for security", String(d.security.run.blockedForSecurity.length)],
                  ["Sandbox", d.security.run.sandbox.used ? `used (${d.security.run.sandbox.testsWithoutNetwork ? "tests without network" : "see executions"}${d.security.run.sandbox.installWithNetwork ? "; install step with network" : ""})` : "not used"],
                ] as Array<[string, React.ReactNode]>)
              : []),
          ]}
        />
        {d.security.analysis.findings.length > 0 && (
          <ul className="divide-y">
            {d.security.analysis.findings.map((f, i) => (
              <li key={i} className="flex min-w-0 flex-wrap items-center gap-2 py-1.5">
                <Badge tone={f.severity === "CRITICAL" || f.severity === "HIGH" ? "critical" : "medium"}>{f.severity}</Badge>
                <Badge>{f.category === "SECRET" ? "secret detected" : f.category.toLowerCase()}</Badge>
                <span className="min-w-0 flex-1 break-words">{f.title}</span>
                {f.path && <Code>{`${f.path}${f.line ? `:${f.line}` : ""}`}</Code>}
              </li>
            ))}
          </ul>
        )}
        {d.security.run && d.security.run.blockedForSecurity.length > 0 && (
          <ul className="space-y-1">
            {d.security.run.blockedForSecurity.map((b, i) => (
              <li key={i} className="flex min-w-0 flex-wrap items-center gap-2">
                <Badge tone="critical">blocked</Badge>
                <Code>{b.path}</Code>
                <span className="text-muted-foreground">{b.flags.join(", ")}</span>
              </li>
            ))}
          </ul>
        )}
        <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
          {d.security.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </Section>

      {/* ---------------------------------------------------------------- errors and warnings */}
      <Section title="Errors and warnings" count={`${d.issues.errors.length} errors · ${d.issues.warnings.length} warnings`}>
        {d.issues.errors.length + d.issues.warnings.length === 0 ? (
          <Empty>None recorded.</Empty>
        ) : (
          <ul className="space-y-1.5" role="list">
            {d.issues.errors.map((i, n) => (
              <li key={`e${n}`} className="flex min-w-0 flex-wrap items-start gap-2">
                <Badge tone="critical">error</Badge>
                <Badge>{i.source}</Badge>
                <span className="min-w-0 flex-1 break-words">{i.message}</span>
              </li>
            ))}
            {d.issues.warnings.map((i, n) => (
              <li key={`w${n}`} className="flex min-w-0 flex-wrap items-start gap-2">
                <Badge tone="medium">warning</Badge>
                <Badge>{i.source}</Badge>
                <span className="min-w-0 flex-1 break-words">{i.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* ---------------------------------------------------------------- limitations */}
      <Section title="Limitations" count={d.limitations.length}>
        <ul className="list-disc space-y-0.5 pl-5">
          {d.limitations.map((l, i) => (
            <li key={i} className="break-words">
              {l}
            </li>
          ))}
        </ul>
      </Section>

      {/* ---------------------------------------------------------------- timeline */}
      <Section title="Timeline" count={d.timeline.length} open={false}>
        <ol className="space-y-1.5">
          {d.timeline.map((t, i) => (
            <li key={i} className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-0.5">
              <span className="w-36 shrink-0 text-xs text-muted-foreground">{when(t.at)}</span>
              <Badge>{t.source}</Badge>
              <span className="order-last min-w-0 basis-full break-words sm:order-none sm:flex-1 sm:basis-0">{t.event}</span>
              {t.actor && <span className="ml-auto text-[11px] text-muted-foreground sm:ml-0">{t.actor}</span>}
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
