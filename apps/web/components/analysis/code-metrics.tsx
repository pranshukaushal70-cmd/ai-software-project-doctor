"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { api } from "@/lib/api-client";
import { cn, formatNumber } from "@/lib/utils";
import { LANGUAGE_NAMES, SEVERITY_LABEL, SEVERITY_TONE } from "./labels";
import type { CodeMetricsDto, FileMetricsDto, SeverityDto } from "./types";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

/** Complexity value coloured against the configured limits. */
function Complexity({ value, limits }: { value: number; limits: CodeMetricsDto["thresholds"]["complexity"] }) {
  const tone = value > limits.high ? "high" : value > limits.medium ? "medium" : "neutral";
  return (
    <Badge tone={tone} className="tabular-nums">
      {value}
    </Badge>
  );
}

const SORTS = [
  { id: "complexity", label: "Complexity" },
  { id: "loc", label: "Size" },
  { id: "duplication", label: "Duplication" },
] as const;

function FileMetricsTable({ analysisId, limits }: { analysisId: string; limits: CodeMetricsDto["thresholds"]["complexity"] }) {
  const [sort, setSort] = useState<(typeof SORTS)[number]["id"]>("complexity");
  const [files, setFiles] = useState<FileMetricsDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    api<{ files: FileMetricsDto[] }>(`/api/analysis/${analysisId}/files?kind=SOURCE&sort=${sort}&pageSize=25`)
      .then((d) => !cancelled && setFiles(d.files.filter((f) => f.loc !== null)))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [analysisId, sort]);

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Source files</CardTitle>
          <CardDescription>Per-file metrics as stored for this analysis.</CardDescription>
        </div>
        <div className="flex gap-1" role="group" aria-label="Sort files">
          {SORTS.map((s) => (
            <button
              key={s.id}
              type="button"
              aria-pressed={sort === s.id}
              onClick={() => setSort(s.id)}
              className={cn("rounded-md px-2.5 py-1 text-xs font-medium", sort === s.id ? "bg-muted" : "text-muted-foreground hover:bg-muted/60")}
            >
              {s.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <p className="text-sm text-sev-critical">{error}</p>
        ) : !files ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-6" />
            ))}
          </div>
        ) : files.length === 0 ? (
          <p className="text-sm text-muted-foreground">No analysed source files.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">File</th>
                  <th className="pb-2 text-right font-medium">Code</th>
                  <th className="pb-2 text-right font-medium">Comments</th>
                  <th className="pb-2 text-right font-medium">Functions</th>
                  <th className="pb-2 text-right font-medium">Max CC</th>
                  <th className="pb-2 text-right font-medium">Nesting</th>
                  <th className="pb-2 text-right font-medium">Duplicated</th>
                  <th className="pb-2 text-right font-medium">Findings</th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id} className="border-t">
                    <td className="max-w-[320px] truncate py-1.5 font-mono text-xs" title={f.path}>
                      {f.path}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatNumber(f.loc ?? 0)}</td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">{formatNumber(f.commentLines ?? 0)}</td>
                    <td className="py-1.5 text-right tabular-nums">{f.functionCount ?? 0}</td>
                    <td className="py-1.5 text-right">
                      <Complexity value={f.maxComplexity ?? 0} limits={limits} />
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{f.maxNesting ?? 0}</td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">{f.duplicatedLines ? formatNumber(f.duplicatedLines) : "–"}</td>
                    <td className="py-1.5 text-right tabular-nums">{f._count.findings || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function CodeMetrics({ analysisId, metrics }: { analysisId: string; metrics: CodeMetricsDto }) {
  const t = metrics.totals;
  const limits = metrics.thresholds.complexity;
  const severities = (Object.entries(metrics.findings.bySeverity) as Array<[SeverityDto, number]>).filter(([, n]) => n > 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Lines of code"
          value={formatNumber(t.codeLines)}
          hint={`${formatNumber(t.logicalLines)} logical · ${formatNumber(t.commentLines)} comment · ${formatNumber(t.blankLines)} blank`}
        />
        <Stat label="Functions" value={formatNumber(t.functions)} hint={`${formatNumber(t.classes)} classes in ${formatNumber(t.filesAnalyzed)} files`} />
        <Stat label="Avg. complexity" value={t.avgComplexity.toFixed(1)} hint={`p90 ${t.p90Complexity} · max ${t.maxComplexity}`} />
        <Stat
          label="Duplication"
          value={`${t.duplicationPercent.toFixed(1)}%`}
          hint={`${formatNumber(t.duplicatedLines)} lines in ${formatNumber(metrics.duplication.clones)} clones`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Code-quality findings</CardTitle>
          <CardDescription>
            {formatNumber(metrics.findings.total)} findings from deterministic static analysis
            {metrics.findings.truncated && ` (the ${formatNumber(metrics.findings.stored)} most severe are stored)`}.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {severities.length === 0 ? (
            <span className="text-sm text-muted-foreground">None.</span>
          ) : (
            severities.map(([s, n]) => (
              <Badge key={s} tone={SEVERITY_TONE[s]}>
                {SEVERITY_LABEL[s]} · {formatNumber(n)}
              </Badge>
            ))
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Complexity hotspots</CardTitle>
            <CardDescription>
              Most complex production functions. Cyclomatic complexity above {limits.medium} is flagged.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {metrics.hotspots.length === 0 ? (
              <p className="text-sm text-muted-foreground">No functions found.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="pb-2 font-medium">Function</th>
                      <th className="pb-2 text-right font-medium">CC</th>
                      <th className="pb-2 text-right font-medium">Lines</th>
                      <th className="pb-2 text-right font-medium">Nesting</th>
                      <th className="pb-2 text-right font-medium">Params</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.hotspots.slice(0, 10).map((h) => (
                      <tr key={`${h.path}:${h.line}:${h.name}`} className="border-t align-top">
                        <td className="max-w-[300px] py-1.5">
                          <div className="truncate font-medium" title={h.name}>
                            {h.name}
                          </div>
                          <div className="truncate font-mono text-xs text-muted-foreground" title={`${h.path}:${h.line}`}>
                            {h.path}:{h.line}
                          </div>
                        </td>
                        <td className="py-1.5 text-right">
                          <Complexity value={h.complexity} limits={limits} />
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{h.codeLines}</td>
                        <td className="py-1.5 text-right tabular-nums">{h.maxNesting}</td>
                        <td className="py-1.5 text-right tabular-nums">{h.parameters}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>By language</CardTitle>
            <CardDescription>Source and test files parsed with tree-sitter.</CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Language</th>
                  <th className="pb-2 text-right font-medium">Code</th>
                  <th className="pb-2 text-right font-medium">Fns</th>
                  <th className="pb-2 text-right font-medium">Avg CC</th>
                </tr>
              </thead>
              <tbody>
                {metrics.byLanguage.map((l) => (
                  <tr key={l.language} className="border-t">
                    <td className="py-1.5">
                      {LANGUAGE_NAMES[l.language] ?? l.language}
                      <span className="ml-1.5 text-xs text-muted-foreground">{l.files} files</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatNumber(l.codeLines)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatNumber(l.functions)}</td>
                    <td className="py-1.5 text-right tabular-nums">{l.avgComplexity.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      <FileMetricsTable analysisId={analysisId} limits={limits} />

      <div className="flex items-start gap-3 rounded-lg border px-4 py-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <div className="flex flex-col gap-1">
          <p>
            Measured by {metrics.analyzer} v{metrics.analyzerVersion} in {formatNumber(metrics.durationMs)} ms with{" "}
            {Object.entries(metrics.parser)
              .map(([pkg, v]) => `${pkg}@${v}`)
              .join(", ")}
            . Findings are produced for production source only; test files are measured but not flagged.
          </p>
          {(metrics.skipped.length > 0 || t.filesWithParseErrors > 0) && (
            <p>
              {metrics.skipped.length > 0 &&
                `${metrics.skipped.length} files were skipped (${[...new Set(metrics.skipped.map((s) => s.reason))].join(", ")}). `}
              {t.filesWithParseErrors > 0 &&
                `${t.filesWithParseErrors} files contained syntax the parser could not fully recognise; their metrics are approximate.`}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
