import type { Certainty, ValidatedPlan, ValidationIssue, ValidationReport } from "@pd/agent";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Renders a validated engineering plan. Every repository claim shows whether it is
 * VERIFIED by cited evidence, INFERRED from it or UNKNOWN, links to the evidence it
 * cites, and carries the validator's flags (e.g. a file that does not exist).
 */

export interface PlanEvidenceDto {
  ref: string;
  kind: string;
  path: string | null;
  symbol: string | null;
  line: number | null;
  summary: string;
  source: string;
}

export interface PlanDto {
  id: string;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  inProgress: boolean;
  provider: string;
  model: string;
  validationStatus: string | null;
  confidence: number | null;
  failureReason: string | null;
  error: string | null;
  plan: ValidatedPlan | null;
  validation: ValidationReport | null;
  contextStats: { searchHits: number; candidateFiles: number; evidence: number; truncated: boolean } | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  evidence: PlanEvidenceDto[];
}

const CERTAINTY_TONE = { VERIFIED: "ok", INFERRED: "medium", UNKNOWN: "neutral" } as const;
const VALIDATION_TONE: Record<string, "ok" | "medium" | "critical"> = { PASSED: "ok", WARNINGS: "medium", ERRORS: "critical", REJECTED: "critical" };
const RISK_TONE = { LOW: "low", MEDIUM: "medium", HIGH: "high" } as const;
const FLAG_LABEL: Record<string, string> = {
  "nonexistent-file": "file not found",
  "nonexistent-symbol": "symbol not found",
  "invalid-path": "invalid path",
  "secret-file": "secret file",
  "file-exists": "already exists",
  "test-not-found": "test not found",
  "implausible-test-path": "unusual test path",
  "unlisted-step-file": "not in affected files",
};

export function CertaintyBadge({ certainty }: { certainty: Certainty }) {
  return (
    <Badge tone={CERTAINTY_TONE[certainty]} title={CERTAINTY_HELP[certainty]}>
      {certainty}
    </Badge>
  );
}
const CERTAINTY_HELP: Record<Certainty, string> = {
  VERIFIED: "Stated by the cited repository evidence",
  INFERRED: "Reasoned from the evidence; not stated by it",
  UNKNOWN: "Not established from the repository",
};

function EvidenceRefs({ refs }: { refs: string[] }) {
  if (refs.length === 0) return <span className="text-xs text-muted-foreground">no evidence</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {refs.map((r) => (
        <a key={r} href={`#evidence-${r}`} className="rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground">
          {r}
        </a>
      ))}
    </span>
  );
}

function Flags({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <>
      {[...new Set(flags)].map((f) => (
        <Badge key={f} tone="critical">
          {FLAG_LABEL[f] ?? f}
        </Badge>
      ))}
    </>
  );
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">
          {title}
          {count !== undefined && <span className="ml-2 text-sm font-normal text-muted-foreground">{count}</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="min-w-0 space-y-2 text-sm">{children}</CardContent>
    </Card>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-muted-foreground">{children}</p>;

function Claims({ items, empty }: { items: ValidatedPlan["assumptions"]; empty: string }) {
  if (items.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="space-y-2">
      {items.map((c, i) => (
        <li key={i} className="flex min-w-0 flex-wrap items-start gap-2">
          <CertaintyBadge certainty={c.certainty} />
          <span className="min-w-0 flex-1 break-words">{c.statement}</span>
          <EvidenceRefs refs={c.evidence} />
        </li>
      ))}
    </ul>
  );
}

/** Counts of VERIFIED / INFERRED / UNKNOWN across every certainty-bearing item. */
export function certaintyCounts(plan: ValidatedPlan): Record<Certainty, number> {
  const all: Certainty[] = [
    ...plan.assumptions,
    ...plan.affectedFiles,
    ...plan.affectedSymbols,
    plan.architectureImpact,
    ...plan.configurationChanges,
    ...plan.dependencyChanges,
    ...plan.securityConsiderations,
    ...plan.performanceConsiderations,
  ].map((c) => c.certainty);
  return { VERIFIED: all.filter((c) => c === "VERIFIED").length, INFERRED: all.filter((c) => c === "INFERRED").length, UNKNOWN: all.filter((c) => c === "UNKNOWN").length };
}

function Issues({ issues }: { issues: ValidationIssue[] }) {
  return (
    <ul className="space-y-1.5">
      {issues.map((i, n) => (
        <li key={n} className="flex min-w-0 flex-wrap items-start gap-2">
          <Badge tone={i.severity === "error" ? "critical" : "medium"}>{i.severity}</Badge>
          <span className="min-w-0 flex-1 break-words">{i.message}</span>
          <code className="min-w-0 break-all text-xs text-muted-foreground">{i.field}</code>
        </li>
      ))}
    </ul>
  );
}

const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${Math.round(n * 100)}%`);

export function PlanView({ plan: dto }: { plan: PlanDto }) {
  if (dto.inProgress) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground" role="status">
          Generating the plan with {dto.provider} ({dto.model}) from repository evidence…
        </CardContent>
      </Card>
    );
  }
  if (dto.status === "FAILED" || !dto.plan) {
    return (
      <div className="space-y-4">
        <Card>
          <CardContent className="py-6 text-sm" role="alert">
            <p className="font-medium text-sev-critical">Planning failed</p>
            <p className="mt-1 text-muted-foreground">{dto.error ?? "No plan was produced."}</p>
          </CardContent>
        </Card>
        {dto.validation && dto.validation.issues.length > 0 && (
          <Section title="Why the output was rejected" count={dto.validation.issues.length}>
            <Issues issues={dto.validation.issues} />
          </Section>
        )}
      </div>
    );
  }

  const p = dto.plan;
  const counts = certaintyCounts(p);
  const report = dto.validation;
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex flex-wrap items-center gap-2">
            {report && <Badge tone={VALIDATION_TONE[report.status] ?? "neutral"}>Validation: {report.status}</Badge>}
            <Badge tone="primary">Confidence {pct(dto.confidence)}</Badge>
            {report && report.modelConfidence !== dto.confidence && <span className="text-xs text-muted-foreground">model said {pct(report.modelConfidence)}; lowered for validation issues</span>}
          </div>
          <p className="text-base font-medium break-words">{p.taskSummary}</p>
          <p className="text-sm text-muted-foreground break-words">{p.interpretation}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              <strong className="text-ok">{counts.VERIFIED}</strong> verified · <strong className="text-sev-medium">{counts.INFERRED}</strong> inferred · <strong>{counts.UNKNOWN}</strong> unknown
            </span>
            <span>{dto.evidence.length} evidence items{dto.contextStats?.truncated ? " (truncated)" : ""}</span>
            <span>
              {dto.provider} · {dto.model}
            </span>
            {dto.durationMs !== null && <span>{(dto.durationMs / 1000).toFixed(1)} s</span>}
            {dto.inputTokens !== null && (
              <span>
                {dto.inputTokens} in / {dto.outputTokens ?? 0} out tokens
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {report && report.issues.length > 0 && (
        <Section title="Validation issues" count={report.issues.length}>
          <Issues issues={report.issues} />
        </Section>
      )}

      <Section title="Affected files" count={p.affectedFiles.length}>
        {p.affectedFiles.length === 0 ? (
          <Empty>No files identified.</Empty>
        ) : (
          <ul className="divide-y">
            {p.affectedFiles.map((f, i) => (
              <li key={i} className={cn("space-y-1 py-2 first:pt-0", f.flags.length > 0 && "opacity-90")}>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <code className={cn("min-w-0 break-all font-mono text-xs", f.flags.includes("nonexistent-file") && "line-through decoration-sev-critical")}>{f.path}</code>
                  <Badge>{f.change}</Badge>
                  <CertaintyBadge certainty={f.certainty} />
                  <Flags flags={f.flags} />
                </div>
                <p className="break-words text-muted-foreground">{f.reason}</p>
                <EvidenceRefs refs={f.evidence} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Affected symbols" count={p.affectedSymbols.length}>
        {p.affectedSymbols.length === 0 ? (
          <Empty>No symbols identified.</Empty>
        ) : (
          <ul className="divide-y">
            {p.affectedSymbols.map((s, i) => (
              <li key={i} className="space-y-1 py-2 first:pt-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <code className="font-mono text-xs font-semibold break-all">{s.name}</code>
                  <code className="min-w-0 break-all font-mono text-xs text-muted-foreground">{s.path}</code>
                  <Badge>{s.change}</Badge>
                  <CertaintyBadge certainty={s.certainty} />
                  <Flags flags={s.flags} />
                </div>
                <p className="break-words text-muted-foreground">{s.reason}</p>
                <EvidenceRefs refs={s.evidence} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Architecture impact">
        <Claims items={[p.architectureImpact]} empty="" />
      </Section>

      <Section title="Implementation steps" count={p.implementationSteps.length}>
        {p.implementationSteps.length === 0 ? (
          <Empty>No steps.</Empty>
        ) : (
          <ol className="list-decimal space-y-3 pl-5">
            {p.implementationSteps.map((s, i) => (
              <li key={i} className="space-y-1">
                <p className="font-medium break-words">{s.title}</p>
                <p className="break-words text-muted-foreground">{s.description}</p>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {s.files.map((f) => (
                    <code key={f} className="min-w-0 break-all rounded bg-muted px-1.5 font-mono text-[11px]">
                      {f}
                    </code>
                  ))}
                  <Flags flags={s.flags} />
                  <EvidenceRefs refs={s.evidence} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title="Test plan" count={p.testPlan.length}>
        {p.testPlan.length === 0 ? (
          <Empty>No tests proposed.</Empty>
        ) : (
          <ul className="space-y-2">
            {p.testPlan.map((t, i) => (
              <li key={i} className="flex min-w-0 flex-wrap items-start gap-2">
                <Badge tone={t.kind === "existing" ? "ok" : "primary"}>{t.kind === "existing" ? "existing test" : "new test"}</Badge>
                <span className="min-w-0 flex-1 break-words">
                  {t.description}
                  {t.path && <code className="ml-1 break-all font-mono text-xs text-muted-foreground">{t.path}</code>}
                </span>
                <Flags flags={t.flags} />
                <EvidenceRefs refs={t.evidence} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
        <Section title="Configuration changes" count={p.configurationChanges.length}>
          {p.configurationChanges.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <ul className="space-y-2">
              {p.configurationChanges.map((c, i) => (
                <li key={i} className="flex min-w-0 flex-wrap items-start gap-2">
                  <CertaintyBadge certainty={c.certainty} />
                  <code className="break-all font-mono text-xs">{c.path}</code>
                  <span className="min-w-0 flex-1 break-words text-muted-foreground">{c.description}</span>
                  <Flags flags={c.flags} />
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Dependency changes" count={p.dependencyChanges.length}>
          {p.dependencyChanges.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <ul className="space-y-2">
              {p.dependencyChanges.map((d, i) => (
                <li key={i} className="flex min-w-0 flex-wrap items-start gap-2">
                  <CertaintyBadge certainty={d.certainty} />
                  <Badge>{d.change}</Badge>
                  <code className="break-all font-mono text-xs">{d.package}</code>
                  <span className="min-w-0 flex-1 break-words text-muted-foreground">{d.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Security considerations" count={p.securityConsiderations.length}>
          <Claims items={p.securityConsiderations} empty="None identified." />
        </Section>
        <Section title="Performance considerations" count={p.performanceConsiderations.length}>
          <Claims items={p.performanceConsiderations} empty="None identified." />
        </Section>
      </div>

      <Section title="Risks" count={p.risks.length}>
        {p.risks.length === 0 ? (
          <Empty>None identified.</Empty>
        ) : (
          <ul className="space-y-2">
            {p.risks.map((r, i) => (
              <li key={i} className="flex min-w-0 flex-wrap items-start gap-2">
                <Badge tone={RISK_TONE[r.severity]}>{r.severity}</Badge>
                <span className="min-w-0 flex-1 break-words">
                  {r.description} <span className="text-muted-foreground">Mitigation: {r.mitigation}</span>
                </span>
                <EvidenceRefs refs={r.evidence} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="grid gap-4 md:grid-cols-2 [&>*]:min-w-0">
        <Section title="Validation plan" count={p.validationPlan.length}>
          {p.validationPlan.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <ul className="list-disc space-y-1 pl-5">
              {p.validationPlan.map((v, i) => (
                <li key={i} className="break-words">
                  {v}
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Assumptions and unknowns" count={p.assumptions.length + p.unknowns.length}>
          <Claims items={p.assumptions} empty="No assumptions stated." />
          {p.unknowns.length > 0 && (
            <ul className="space-y-1.5 pt-1">
              {p.unknowns.map((u, i) => (
                <li key={i} className="flex min-w-0 items-start gap-2">
                  <CertaintyBadge certainty="UNKNOWN" />
                  <span className="min-w-0 flex-1 break-words">{u}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section title="Repository evidence" count={dto.evidence.length}>
        <p className="text-xs text-muted-foreground">Facts from the deterministic repository index that the plan was generated from. The planner saw only these, never file contents.</p>
        <ul className="divide-y">
          {dto.evidence.map((e) => (
            <li key={e.ref} id={`evidence-${e.ref}`} className="flex min-w-0 flex-wrap items-start gap-2 py-1.5 target:bg-accent/40">
              <code className="w-9 shrink-0 font-mono text-xs text-muted-foreground">{e.ref}</code>
              <Badge>{e.kind}</Badge>
              <span className="min-w-0 flex-1 break-words">{e.summary}</span>
              <span className="text-[11px] text-muted-foreground">{e.source}</span>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
