"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Info, Network, RefreshCcw } from "lucide-react";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { api } from "@/lib/api-client";
import { cn, formatNumber } from "@/lib/utils";
import { FilterChip, FindingsList } from "./findings-list";
import { LAYOUT, layoutGraph, shortenLabel } from "./graph-layout";
import { LANGUAGE_NAMES, LAYER_LABEL, SEVERITY_LABEL, SEVERITY_TONE } from "./labels";
import { Stat } from "./stat";
import type { ArchitectureGraphDto, ArchitectureSummaryDto, GraphEdgeDto, GraphNodeDto } from "./types";

/** Node limits per view: enough to be useful, few enough to stay legible. */
const GRAPH_LIMIT = { modules: 60, files: 80 } as const;

const num = (v: unknown) => (typeof v === "number" ? v : 0);

/** Layered SVG diagram of an import graph. Exported for tests. */
export function ImportGraph({
  nodes,
  edges,
  onSelect,
}: {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  /** Called with a node's key when it is clicked (module view: drill into its files). */
  onSelect?: (key: string) => void;
}) {
  const layout = useMemo(() => layoutGraph({ nodes, edges }), [nodes, edges]);
  const [hovered, setHovered] = useState<string | null>(null);
  const { nodeWidth: W, nodeHeight: H } = LAYOUT;
  const byKey = new Map(nodes.map((n) => [n.key, n]));

  return (
    <div className="overflow-auto rounded-lg border bg-muted/20" style={{ maxHeight: 560 }}>
      <svg
        width={layout.width + 48}
        height={layout.height}
        role="img"
        aria-label={`Import graph: ${nodes.length} nodes, ${edges.length} dependencies. Arrows point from the importer to the imported code.`}
        className="text-foreground"
      >
        <defs>
          {(["edge", "cycle"] as const).map((id) => (
            <marker key={id} id={`arrow-${id}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill={id === "cycle" ? "var(--sev-critical)" : "var(--muted-foreground)"} />
            </marker>
          ))}
        </defs>
        {edges.map((e) => {
          const s = layout.nodes.get(e.from);
          const t = layout.nodes.get(e.to);
          if (!s || !t) return null;
          const sy = s.y + H / 2;
          const ty = t.y + H / 2;
          // Forward edges run left to right; edges inside a cycle (same column) loop around the right side.
          const d =
            t.col > s.col
              ? `M${s.x + W},${sy} C${s.x + W + 36},${sy} ${t.x - 36},${ty} ${t.x - 2},${ty}`
              : `M${s.x + W},${sy} C${s.x + W + 44},${sy} ${t.x + W + 44},${ty} ${t.x + W + 2},${ty}`;
          const dim = hovered !== null && hovered !== e.from && hovered !== e.to;
          return (
            <path
              key={`${e.from}>${e.to}`}
              d={d}
              fill="none"
              stroke={e.inCycle ? "var(--sev-critical)" : "var(--muted-foreground)"}
              strokeWidth={1 + Math.min(Math.log2(Math.max(e.weight, 1)), 3)}
              strokeOpacity={dim ? 0.12 : e.inCycle ? 0.85 : 0.45}
              markerEnd={`url(#arrow-${e.inCycle ? "cycle" : "edge"})`}
            >
              <title>
                {`${byKey.get(e.from)?.label} → ${byKey.get(e.to)?.label}${e.weight > 1 ? ` (${e.weight} imports)` : ""}${e.inCycle ? " · part of a cycle" : ""}`}
              </title>
            </path>
          );
        })}
        {nodes.map((n) => {
          const p = layout.nodes.get(n.key)!;
          const m = n.metrics ?? {};
          const inCycle = m.inCycle === true;
          return (
            <g
              key={n.key}
              transform={`translate(${p.x},${p.y})`}
              onMouseEnter={() => setHovered(n.key)}
              onMouseLeave={() => setHovered(null)}
              onClick={onSelect ? () => onSelect(n.key) : undefined}
              className={onSelect ? "cursor-pointer" : undefined}
            >
              <title>{`${n.label}\nimported by ${num(m.fanIn)} · imports ${num(m.fanOut)}${typeof m.files === "number" ? ` · ${m.files} files` : ""}${inCycle ? "\npart of an import cycle" : ""}`}</title>
              <rect
                width={W}
                height={H}
                rx={6}
                fill="var(--card)"
                stroke={inCycle ? "var(--sev-critical)" : hovered === n.key ? "var(--primary)" : "var(--border)"}
                strokeWidth={inCycle || hovered === n.key ? 1.5 : 1}
              />
              <text x={10} y={H / 2 + 4} fontSize={11} fontFamily="var(--font-mono, ui-monospace, monospace)" fill="currentColor">
                {shortenLabel(n.label)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Graph card states: loading (graph null), error, empty, or the diagram. Exported for tests. */
export function GraphView({ graph, error, onSelect }: { graph: ArchitectureGraphDto | null; error: string | null; onSelect?: (key: string) => void }) {
  if (error) return <p className="text-sm text-sev-critical">{error}</p>;
  if (!graph) {
    return (
      <div role="status" aria-label="Loading graph">
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (graph.nodes.length === 0) {
    return <p className="text-sm text-muted-foreground">No files match this view.</p>;
  }
  if (graph.edges.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {graph.view === "modules"
          ? "The modules do not import each other: every import stays inside its own directory."
          : "None of these files import each other."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <ImportGraph nodes={graph.nodes} edges={graph.edges} onSelect={onSelect} />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <ArrowRight className="size-3.5" aria-hidden /> importer → imported
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-sev-critical" aria-hidden /> part of an import cycle
        </span>
        <span>thicker = more imports</span>
        {graph.truncated && (
          <span>
            showing the {formatNumber(graph.nodes.length)} most connected of {formatNumber(graph.total)}
          </span>
        )}
      </div>
    </div>
  );
}

function GraphCard({ analysisId, summary }: { analysisId: string; summary: ArchitectureSummaryDto }) {
  const [view, setView] = useState<"modules" | "files">(summary.totals.modules > 1 ? "modules" : "files");
  const [module, setModule] = useState<string | null>(null);
  const [cyclesOnly, setCyclesOnly] = useState(false);
  const [graph, setGraph] = useState<ArchitectureGraphDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setGraph(null);
    setError(null);
    const params = new URLSearchParams({ view, limit: String(GRAPH_LIMIT[view]) });
    if (view === "files" && module) params.set("module", module);
    if (view === "files" && cyclesOnly) params.set("cycles", "true");
    api<ArchitectureGraphDto>(`/api/analysis/${analysisId}/architecture?${params}`)
      .then((g) => !cancelled && setGraph(g))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [analysisId, view, module, cyclesOnly]);

  const drillInto = (key: string) => {
    setModule(key.replace(/^module:/, ""));
    setView("files");
  };

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Import graph</CardTitle>
          <CardDescription>
            {view === "modules"
              ? `Directories at depth ${summary.moduleDepth} and the imports between them. Click a module to see its files.`
              : "Source files and the files they import (tests and generated code are excluded)."}
          </CardDescription>
        </div>
        <div className="flex gap-1" role="group" aria-label="Graph level">
          {(["modules", "files"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={cn("rounded-md px-2.5 py-1 text-xs font-medium", view === v ? "bg-muted" : "text-muted-foreground hover:bg-muted/60")}
            >
              {v === "modules" ? "Modules" : "Files"}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {view === "files" && (
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Module"
              value={module ?? ""}
              onChange={(e) => setModule(e.target.value || null)}
              className="h-8 max-w-[280px] rounded-md border bg-card px-2 text-sm"
            >
              <option value="">All modules</option>
              {summary.modules.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label} ({m.files})
                </option>
              ))}
            </select>
            {summary.totals.cycles > 0 && (
              <FilterChip active={cyclesOnly} onClick={() => setCyclesOnly((c) => !c)}>
                Only files in cycles
              </FilterChip>
            )}
          </div>
        )}
        <GraphView graph={graph} error={error} onSelect={view === "modules" ? drillInto : undefined} />
      </CardContent>
    </Card>
  );
}

function CyclesCard({ cycles, total }: { cycles: ArchitectureSummaryDto["cycles"]; total: number }) {
  return (
    <Card className="border-sev-high/30">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RefreshCcw className="size-4 text-sev-high" aria-hidden /> Import cycles
        </CardTitle>
        <CardDescription>Each cycle is shown by its shortest loop; files in a cycle cannot be loaded, tested or reused independently.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3">
          {cycles.map((c) => (
            <li key={c.files.join("|")} className="flex flex-col gap-1.5 border-t pt-3 first:border-t-0 first:pt-0">
              <div className="flex items-center gap-2 text-sm">
                <Badge tone={SEVERITY_TONE[c.severity]}>{SEVERITY_LABEL[c.severity]}</Badge>
                <span className="text-muted-foreground">
                  {c.size} {c.size === 1 ? "file" : "files"}
                </span>
              </div>
              <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-xs" aria-label="Cycle path">
                {c.path.map((p, i) => (
                  <li key={`${p}-${i}`} className="flex items-center gap-1.5">
                    {i > 0 && <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />}
                    <span className="rounded bg-muted px-1.5 py-0.5">{p}</span>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ul>
        {total > cycles.length && <p className="mt-3 text-xs text-muted-foreground">Showing {cycles.length} of {formatNumber(total)} cycles.</p>}
      </CardContent>
    </Card>
  );
}

function FileList({ title, description, files, metric }: { title: string; description: string; files: ArchitectureSummaryDto["hubs"]; metric: "fanIn" | "fanOut" }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {files.length === 0 ? (
          <p className="text-sm text-muted-foreground">No internal imports.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {files.map((f) => (
              <li key={f.path} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
                  {f.path}
                </span>
                <span className="shrink-0 tabular-nums">{formatNumber(f[metric])}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function ArchitecturePanel({ analysisId, summary }: { analysisId: string; summary: ArchitectureSummaryDto }) {
  const t = summary.totals;

  if (t.files === 0) {
    return (
      <Card>
        <CardContent className="flex items-start gap-3 pt-5">
          <Network className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div>
            <div className="font-medium">No source files to map</div>
            <p className="text-sm text-muted-foreground">
              The import graph covers production source files in JavaScript, TypeScript, Python, Java, C and C++. None were found in this
              repository.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Source files" value={formatNumber(t.files)} hint={`${formatNumber(t.edges)} internal imports · ${formatNumber(t.isolatedFiles)} isolated`} />
        <Stat
          label="Import cycles"
          value={formatNumber(t.cycles)}
          hint={t.cycles > 0 ? `${formatNumber(t.filesInCycles)} files involved` : "none found"}
          tone={t.cycles > 0 ? "alert" : "ok"}
        />
        <Stat label="Modules" value={formatNumber(t.modules)} hint={`${formatNumber(t.moduleEdges)} dependencies between them`} />
        <Stat
          label="Coupling"
          value={`${t.maxFanOut}`}
          hint={`max imports by one file · avg ${t.avgFanOut} · max imported by ${formatNumber(t.maxFanIn)}`}
        />
      </div>

      {summary.cycles.length > 0 && <CyclesCard cycles={summary.cycles} total={t.cycles} />}

      <GraphCard analysisId={analysisId} summary={summary} />

      <Card>
        <CardHeader>
          <CardTitle>Modules</CardTitle>
          <CardDescription>
            Instability = imports out ÷ (imports in + out): 0 means other modules depend on it (keep it stable), 1 means it only depends on
            others.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Module</th>
                  <th className="pb-2 text-right font-medium">Files</th>
                  <th className="pb-2 text-right font-medium">Code lines</th>
                  <th className="pb-2 text-right font-medium">Used by</th>
                  <th className="pb-2 text-right font-medium">Uses</th>
                  <th className="pb-2 pl-4 font-medium">Instability</th>
                  <th className="pb-2 font-medium">Layer</th>
                </tr>
              </thead>
              <tbody>
                {summary.modules.map((m) => (
                  <tr key={m.key} className="border-t">
                    <td className="max-w-[260px] py-1.5 pr-3">
                      <span className="flex items-center gap-2">
                        <span className="truncate font-mono text-xs" title={m.key}>
                          {m.label}
                        </span>
                        {m.inCycle && <Badge tone="high">cycle</Badge>}
                      </span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatNumber(m.files)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatNumber(m.loc)}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.fanIn}</td>
                    <td className="py-1.5 text-right tabular-nums">{m.fanOut}</td>
                    <td className="py-1.5 pl-4">
                      <span className="flex items-center gap-2">
                        <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted" aria-hidden>
                          <span className="block h-full bg-primary" style={{ width: `${m.instability * 100}%` }} />
                        </span>
                        <span className="tabular-nums text-xs text-muted-foreground">{m.instability.toFixed(2)}</span>
                      </span>
                    </td>
                    <td className="py-1.5 text-xs text-muted-foreground">{m.layer ? LAYER_LABEL[m.layer] : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {t.modules > summary.modules.length && (
            <p className="mt-3 text-xs text-muted-foreground">
              Showing the {summary.modules.length} largest of {formatNumber(t.modules)} modules.
            </p>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <FileList title="Most imported files" description="Hubs: a change here affects every importer." files={summary.hubs} metric="fanIn" />
        <FileList title="Files importing the most" description="These depend on many parts of the code base." files={summary.mostDependent} metric="fanOut" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Layers</CardTitle>
            <CardDescription>Inferred from directory and file names. Imports should point down this list, never up.</CardDescription>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-1.5">
              {summary.layers.order.map((l, i) => (
                <li key={l.id} className="flex items-center gap-2 text-sm">
                  <span className="w-4 text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                  <span className={cn("flex-1", l.files === 0 && "text-muted-foreground")}>{l.label}</span>
                  <span className="tabular-nums text-muted-foreground">{formatNumber(l.files)} files</span>
                </li>
              ))}
            </ol>
            <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
              {summary.layers.applied
                ? summary.layers.violations === 0
                  ? "No upward imports between layers."
                  : `${formatNumber(summary.layers.violations)} upward ${summary.layers.violations === 1 ? "import" : "imports"} found (see findings below).`
                : "Fewer than two layers were recognised, so layering was not checked."}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>External packages</CardTitle>
            <CardDescription>Third-party modules imported by the most files.</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.topExternal.length === 0 ? (
              <p className="text-sm text-muted-foreground">No third-party imports.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {summary.topExternal.map((e) => (
                  <li key={`${e.language}:${e.name}`} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{e.name}</span>
                    <span className="text-xs text-muted-foreground">{LANGUAGE_NAMES[e.language] ?? e.language}</span>
                    <span className="w-16 text-right tabular-nums text-muted-foreground">{formatNumber(e.files)} files</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {summary.findings.total > 0 && (
        <section aria-label="Architecture findings" className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Architecture findings</h2>
          <FindingsList analysisId={analysisId} categories="ARCHITECTURE" emptyMessage="No architecture findings." />
        </section>
      )}

      <div className="flex items-start gap-3 rounded-lg border px-4 py-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <div className="flex flex-col gap-1">
          <p>
            Imports are resolved statically from the source ({formatNumber(t.internalImports)} internal, {formatNumber(t.externalImports)}{" "}
            third-party, {formatNumber(t.builtinImports)} standard library)
            {summary.resolution.tsconfigs > 0 && `, using ${summary.resolution.tsconfigs} tsconfig/jsconfig files with ${summary.resolution.pathAliases} path aliases`}
            {summary.resolution.workspacePackages > 0 && ` and ${summary.resolution.workspacePackages} workspace packages`}.{" "}
            {t.unresolvedImports > 0 &&
              `${formatNumber(t.unresolvedImports)} local-looking imports matched no file (generated code, build-time aliases or dynamic paths), so some links may be missing.`}
          </p>
          <p>
            Dynamic imports built at runtime and dependency injection are not visible to static analysis. Measured by {summary.analyzer} v
            {summary.analyzerVersion} in {formatNumber(summary.durationMs)} ms.
          </p>
        </div>
      </div>
    </div>
  );
}
