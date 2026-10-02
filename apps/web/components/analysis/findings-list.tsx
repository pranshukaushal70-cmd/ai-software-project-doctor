"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, FileCode2 } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { api } from "@/lib/api-client";
import { cn, formatNumber } from "@/lib/utils";
import { EvidenceText } from "./evidence-text";
import { CATEGORY_LABEL, SECRET_CONTEXT_BADGE, SEVERITY_LABEL, SEVERITY_TONE, typeLabel } from "./labels";
import type { FindingDto, FindingsPageDto, SeverityDto, TriageDto } from "./types";

const PAGE_SIZE = 50;

function location(f: FindingDto): string {
  if (!f.path) return "repository";
  if (!f.line) return f.path;
  return f.endLine && f.endLine !== f.line ? `${f.path}:${f.line}–${f.endLine}` : `${f.path}:${f.line}`;
}

const TRIAGE_LABEL: Record<TriageDto["status"], string> = { EXPECTED: "Expected", IGNORED: "Ignored" };

/**
 * Mark one finding as Expected or Ignored. The decision is stored for this repository
 * and the finding's fingerprint, so it is shown again on re-analysis but never hides
 * any other finding.
 */
function TriageControls({ analysisId, findingId, triage, onChange }: { analysisId: string; findingId: string; triage: TriageDto | null; onChange: (t: TriageDto | null) => void }) {
  const [reason, setReason] = useState(triage?.reason ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/analysis/${analysisId}/findings/${findingId}/triage`;
  const run = async (fn: () => Promise<TriageDto | null>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const mark = (status: TriageDto["status"]) =>
    run(async () => (await api<{ triage: TriageDto }>(url, { method: "PUT", body: JSON.stringify({ status, reason }) })).triage);

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3 md:col-span-2">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Triage</div>
      <p className="text-xs text-muted-foreground">
        Applies to this exact finding in this repository, including future analyses. It stays listed with a label; other findings are never
        hidden.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          placeholder="Reason (optional), e.g. fake key in a test fixture"
          aria-label="Triage reason"
          className="h-8 min-w-[220px] flex-1 rounded-md border bg-card px-2.5 text-sm"
        />
        <Button size="sm" variant={triage?.status === "EXPECTED" ? "default" : "outline"} disabled={busy} onClick={() => mark("EXPECTED")}>
          Mark expected
        </Button>
        <Button size="sm" variant={triage?.status === "IGNORED" ? "default" : "outline"} disabled={busy} onClick={() => mark("IGNORED")}>
          Ignore
        </Button>
        {triage && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => (await api(url, { method: "DELETE" }), null))}>
            Clear
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-sev-critical">{error}</p>}
    </div>
  );
}

/** Exported for tests. Triage controls are shown when `analysisId` is given. */
export function FindingRow({ finding, analysisId }: { finding: FindingDto; analysisId?: string }) {
  const [open, setOpen] = useState(false);
  const [triage, setTriage] = useState<TriageDto | null>(finding.triage ?? null);
  const context = typeof finding.data?.context === "string" ? SECRET_CONTEXT_BADGE[finding.data.context] : undefined;
  return (
    <li className="border-t first:border-t-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-5 py-3.5 text-left hover:bg-muted/40"
      >
        <ChevronRight className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={SEVERITY_TONE[finding.severity]}>{SEVERITY_LABEL[finding.severity]}</Badge>
            {finding.category !== "CODE_QUALITY" && <Badge tone="neutral">{CATEGORY_LABEL[finding.category] ?? finding.category}</Badge>}
            {context && <Badge tone="neutral">{context}</Badge>}
            {finding.data?.likelyIntentional === true && <Badge tone="ok">Likely intentional</Badge>}
            {triage && (
              <Badge tone="primary" title={triage.reason ?? undefined}>
                {TRIAGE_LABEL[triage.status]}
              </Badge>
            )}
            <span className="font-medium">{finding.title}</span>
          </div>
          <div className="mt-1 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <FileCode2 className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate" title={location(finding)}>
              {location(finding)}
            </span>
          </div>
          {finding.evidence && (
            <p className="mt-2 text-sm leading-relaxed">
              <EvidenceText text={finding.evidence} />
            </p>
          )}
        </div>
      </button>
      {open && (
        <div className="grid gap-4 px-5 pb-4 pl-12 text-sm md:grid-cols-2">
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Why it matters</div>
            <p className="leading-relaxed">{finding.impact}</p>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Recommendation</div>
            <p className="leading-relaxed">{finding.recommendation}</p>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground md:col-span-2">
            <span>
              rule <span className="font-mono">{finding.ruleId}</span>
            </span>
            {typeof finding.data?.cwe === "string" && (
              <a
                href={`https://cwe.mitre.org/data/definitions/${finding.data.cwe.replace(/^CWE-/, "")}.html`}
                target="_blank"
                rel="noreferrer noopener"
                className="font-mono underline-offset-2 hover:text-foreground hover:underline"
              >
                {finding.data.cwe}
              </a>
            )}
            {typeof finding.data?.owasp === "string" && <span>OWASP {finding.data.owasp}</span>}
            <span>
              {finding.analyzer} v{finding.analyzerVersion}
            </span>
            <span title={finding.fingerprint}>
              fingerprint <span className="font-mono">{finding.fingerprint.slice(0, 12)}</span>
            </span>
          </div>
          {analysisId && <TriageControls analysisId={analysisId} findingId={finding.id} triage={triage} onChange={setTriage} />}
        </div>
      )}
    </li>
  );
}

export function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

export function FindingsList({
  analysisId,
  categories,
  emptyMessage = "No findings. Nice work.",
}: {
  analysisId: string;
  /** Comma-separated FindingCategory values to scope the list to (a string, so it is referentially stable). */
  categories?: string;
  emptyMessage?: string;
}) {
  const [severity, setSeverity] = useState<SeverityDto | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [hideTriaged, setHideTriaged] = useState(false);
  const [data, setData] = useState<FindingsPageDto | null>(null);
  const [items, setItems] = useState<FindingDto[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Bumped whenever the filters change, so a slow "load more" cannot append results for old filters. */
  const generation = useRef(0);

  const fetchPage = useCallback(
    (page: number) => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (categories) params.set("category", categories);
      if (severity) params.set("severity", severity);
      if (type) params.set("type", type);
      if (hideTriaged) params.set("triage", "untriaged");
      return api<FindingsPageDto>(`/api/analysis/${analysisId}/findings?${params}`);
    },
    [analysisId, categories, severity, type, hideTriaged],
  );

  useEffect(() => {
    let cancelled = false;
    generation.current++;
    setData(null);
    setError(null);
    fetchPage(1)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setItems(d.findings);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  const loadMore = async () => {
    if (!data) return;
    const gen = generation.current;
    setLoadingMore(true);
    try {
      const next = await fetchPage(data.page + 1);
      if (gen !== generation.current) return;
      setData(next);
      setItems((prev) => [...prev, ...next.findings]);
    } catch (e) {
      if (gen === generation.current) setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const allCount = data?.facets.severity.reduce((n, s) => n + s.count, 0) ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by severity">
          <FilterChip active={severity === null} onClick={() => setSeverity(null)}>
            All <span className="tabular-nums opacity-70">{formatNumber(allCount)}</span>
          </FilterChip>
          {data?.facets.severity.map((s) => (
            <FilterChip key={s.value} active={severity === s.value} onClick={() => setSeverity(severity === s.value ? null : s.value)}>
              {SEVERITY_LABEL[s.value]} <span className="tabular-nums opacity-70">{formatNumber(s.count)}</span>
            </FilterChip>
          ))}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <FilterChip active={hideTriaged} onClick={() => setHideTriaged((h) => !h)}>
            Hide expected &amp; ignored
          </FilterChip>
        </div>
        {data && data.facets.type.length > 1 && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Type</span>
            <select
              value={type ?? ""}
              onChange={(e) => setType(e.target.value || null)}
              className="h-8 rounded-md border bg-card px-2 text-sm"
            >
              <option value="">All types</option>
              {data.facets.type.map((t) => (
                <option key={t.value} value={t.value}>
                  {typeLabel(t.value)} ({t.count})
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <Card className="overflow-hidden">
        {error ? (
          <CardContent className="pt-5 text-sm text-sev-critical">{error}</CardContent>
        ) : !data ? (
          <div className="flex flex-col gap-3 p-5">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-14" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <CardContent className="pt-5 text-sm text-muted-foreground">
            {allCount === 0 ? emptyMessage : "No findings match these filters."}
          </CardContent>
        ) : (
          <ul aria-label="Findings">
            {items.map((f) => (
              <FindingRow key={f.id} finding={f} analysisId={analysisId} />
            ))}
          </ul>
        )}
      </Card>

      {data && items.length < data.total && (
        <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
          <span>
            Showing {formatNumber(items.length)} of {formatNumber(data.total)}
          </span>
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </div>
  );
}
