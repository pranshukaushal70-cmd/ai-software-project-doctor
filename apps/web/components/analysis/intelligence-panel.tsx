"use client";

import { useState } from "react";
import { Info, Loader2, Search, Target } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/form";
import { api } from "@/lib/api-client";
import { formatNumber } from "@/lib/utils";
import { GraphView } from "./architecture-panel";
import { FileTree } from "./file-tree";
import { LANGUAGE_NAMES } from "./labels";
import { Stat } from "./stat";
import type { DetectionDto, ImpactDto, IntelligenceSummaryDto, SymbolDto } from "./types";

type ImpactType = "file" | "symbol" | "module";

const SYMBOL_KIND_LABEL: Record<string, string> = {
  FUNCTION: "function",
  CLASS: "class",
  METHOD: "method",
  INTERFACE: "interface",
  TYPE: "type",
  ENUM: "enum",
  CONSTANT: "constant",
  VARIABLE: "variable",
};

function Facts({ title, items }: { title: string; items: Array<{ key: string; label: string; detail?: string }> }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">None detected</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {items.slice(0, 12).map((i) => (
            <li key={i.key} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="min-w-0 break-all font-medium">{i.label}</span>
              {i.detail && (
                <span className="min-w-0 max-w-full truncate font-mono text-xs text-muted-foreground" title={i.detail}>
                  {i.detail}
                </span>
              )}
            </li>
          ))}
          {items.length > 12 && <li className="text-xs text-muted-foreground">and {items.length - 12} more</li>}
        </ul>
      )}
    </div>
  );
}

const detections = (ds: DetectionDto[]) => ds.map((d) => ({ key: `${d.name}${d.evidence}`, label: d.name, detail: d.evidence }));
const paths = (ps: string[]) => ps.map((p) => ({ key: p, label: p }));

/** Repository manifest: what the repository is made of and how it is built, run, tested and deployed. Exported for tests. */
export function ManifestCard({ summary }: { summary: IntelligenceSummaryDto }) {
  const m = summary.manifest;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Repository manifest</CardTitle>
        <CardDescription>
          {m.name}
          {m.primaryLanguage && ` · mostly ${LANGUAGE_NAMES[m.primaryLanguage] ?? m.primaryLanguage}`}. Every entry names the file it was derived from.
        </CardDescription>
      </CardHeader>
      {/* min-w-0: long evidence paths truncate instead of widening the grid on narrow screens. */}
      <CardContent className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 [&>*]:min-w-0">
        <Facts title="Languages" items={m.languages.map((l) => ({ key: l.language, label: LANGUAGE_NAMES[l.language] ?? l.language, detail: `${l.share}% · ${formatNumber(l.files)} files` }))} />
        <Facts title="Runtimes" items={m.runtimes.map((r) => ({ key: `${r.name}${r.evidence}${r.version}`, label: `${r.name} ${r.version}`, detail: r.evidence }))} />
        <Facts title="Frameworks & libraries" items={detections(m.frameworks)} />
        <Facts title="Test frameworks" items={detections(m.testFrameworks)} />
        <Facts title="Package managers & build" items={detections([...m.packageManagers, ...m.buildSystems])} />
        <Facts title="Manifests & lockfiles" items={[...m.manifests.map((x) => ({ key: x.path, label: x.path, detail: x.ecosystem })), ...paths(m.lockfiles)]} />
        <Facts title="CI/CD" items={detections(m.ci)} />
        <Facts title="Docker & infrastructure" items={paths([...m.docker.dockerfiles, ...m.docker.compose, ...m.infrastructure.filter((p) => !m.docker.dockerfiles.includes(p) && !m.docker.compose.includes(p))])} />
        <Facts
          title="Source & test directories"
          items={[...m.sourceDirs.map((d) => ({ key: `s${d.path}`, label: d.path, detail: `${formatNumber(d.files)} source files` })), ...m.testDirs.map((d) => ({ key: `t${d.path}`, label: d.path, detail: `${formatNumber(d.files)} test files` }))]}
        />
      </CardContent>
      {m.secretFiles.length > 0 && (
        <p className="border-t px-5 py-3 text-xs text-muted-foreground">
          {m.secretFiles.length} secret {m.secretFiles.length === 1 ? "file was" : "files were"} found by name ({m.secretFiles.slice(0, 5).join(", ")}) and excluded: their
          contents are never read into the index.
        </p>
      )}
    </Card>
  );
}

function SymbolSearch({ analysisId, onImpact }: { analysisId: string; onImpact: (type: ImpactType, target: string, path?: string) => void }) {
  const [q, setQ] = useState("");
  const [state, setState] = useState<{ symbols: SymbolDto[]; total: number } | null>(null);
  const [callers, setCallers] = useState<{ id: string; rows: Array<{ path: string; line: number; caller: string | null }> } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setPending(true);
    setError(null);
    setCallers(null);
    try {
      const data = await api<{ symbols: SymbolDto[]; total: number }>(`/api/analysis/${analysisId}/symbols?q=${encodeURIComponent(q.trim())}&pageSize=20`);
      setState(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setPending(false);
    }
  }

  async function showCallers(id: string) {
    const data = await api<{ references: Array<{ path: string; line: number; caller: string | null }> }>(`/api/analysis/${analysisId}/references?symbolId=${id}&pageSize=50`);
    setCallers({ id, rows: data.references });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Symbols</CardTitle>
        <CardDescription>Where is a function, class or type defined, and who calls it?</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <form onSubmit={search} className="flex gap-2">
          <Input aria-label="Symbol name" placeholder="e.g. authenticateUser" value={q} onChange={(e) => setQ(e.target.value)} className="font-mono" />
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Search />} Find
          </Button>
        </form>
        {error && <p className="text-sm text-sev-critical">{error}</p>}
        {state && state.symbols.length === 0 && <p className="text-sm text-muted-foreground">No symbol matches “{q}”.</p>}
        {state && state.symbols.length > 0 && (
          <ul className="flex flex-col divide-y text-sm">
            {state.symbols.map((s) => (
              <li key={s.id} className="flex flex-col gap-1 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{SYMBOL_KIND_LABEL[s.kind] ?? s.kind}</Badge>
                  <span className="font-mono font-medium">{s.parent ? `${s.parent}.${s.name}` : s.name}</span>
                  {s.exported && <Badge tone="primary">exported</Badge>}
                  <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-muted-foreground">
                    {s.path}:{s.line}
                  </span>
                </div>
                {s.signature && <code className="truncate text-xs text-muted-foreground">{s.signature}</code>}
                <div className="flex gap-3 text-xs">
                  <button type="button" className="text-primary hover:underline" onClick={() => showCallers(s.id)}>
                    {s.callers} resolved {s.callers === 1 ? "caller" : "callers"}
                  </button>
                  <button type="button" className="text-primary hover:underline" onClick={() => onImpact("symbol", s.name, s.path)}>
                    Impact of changing it
                  </button>
                </div>
                {callers?.id === s.id && (
                  <ul className="ml-2 flex flex-col gap-0.5 border-l pl-3 font-mono text-xs text-muted-foreground">
                    {callers.rows.length === 0 ? (
                      <li>No call resolves to this symbol (it may be called dynamically or through a method).</li>
                    ) : (
                      callers.rows.map((c) => (
                        <li key={`${c.path}:${c.line}`}>
                          {c.path}:{c.line}
                          {c.caller && ` in ${c.caller}`}
                        </li>
                      ))
                    )}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        {state && state.total > state.symbols.length && (
          <p className="text-xs text-muted-foreground">
            Showing {state.symbols.length} of {formatNumber(state.total)}; refine the name.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function PathList({ title, items, empty }: { title: string; items: Array<{ key: string; label: string; detail?: string }>; empty: string }) {
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title} <span className="tabular-nums">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto font-mono text-xs">
          {items.map((i) => (
            <li key={i.key} className="flex justify-between gap-3">
              <span className="truncate" title={i.label}>
                {i.label}
              </span>
              {i.detail && <span className="shrink-0 text-muted-foreground">{i.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The result of an impact analysis. Exported for tests. */
export function ImpactResultView({ impact }: { impact: ImpactDto }) {
  if (!impact.target.found) {
    return <p className="text-sm text-muted-foreground">Nothing in the index matches “{impact.target.value}”. Use a repository-relative file path, a module directory or a symbol name.</p>;
  }
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm">
        Changing <span className="font-mono">{impact.target.value}</span> can affect <strong>{formatNumber(impact.transitiveDependents.length)}</strong>{" "}
        {impact.transitiveDependents.length === 1 ? "file" : "files"} in {impact.affectedModules.length} {impact.affectedModules.length === 1 ? "module" : "modules"},{" "}
        <strong>{impact.relatedTests.length}</strong> {impact.relatedTests.length === 1 ? "test" : "tests"} and <strong>{impact.relatedRoutes.length}</strong> API{" "}
        {impact.relatedRoutes.length === 1 ? "route" : "routes"}.
        {impact.truncated && " The list was cut at the limit."}
      </p>
      <GraphView graph={{ ...impact.graph, summary: null }} error={null} />
      <div className="grid gap-5 md:grid-cols-2">
        <PathList title="Directly affected" items={impact.directDependents.map((p) => ({ key: p, label: p }))} empty="No file depends on it directly." />
        <PathList title="Transitively affected" items={impact.transitiveDependents.map((d) => ({ key: d.path, label: d.path, detail: `distance ${d.depth}` }))} empty="Nothing depends on it." />
        {impact.target.type === "symbol" && (
          <PathList
            title="Call sites"
            items={impact.callers.map((c) => ({ key: `${c.path}:${c.line}`, label: `${c.path}:${c.line}`, detail: c.resolved ? (c.caller ?? "module level") : "same name, unresolved" }))}
            empty="No call site found."
          />
        )}
        <PathList title="Related tests" items={impact.relatedTests.map((t) => ({ key: t.path, label: t.path, detail: t.reason === "imports" ? `imports it (distance ${t.depth})` : "named after it" }))} empty="No test imports it or is named after it." />
        <PathList title="API routes" items={impact.relatedRoutes.map((r) => ({ key: `${r.method}${r.path}`, label: `${r.method} ${r.path}`, detail: `${r.file}:${r.line}` }))} empty="No route handler is affected." />
        <PathList title="Configuration" items={impact.relatedConfig.map((c) => ({ key: c.path, label: c.path, detail: c.reason }))} empty="No manifest or configuration found." />
        <PathList title="Its dependencies" items={impact.dependencies.map((p) => ({ key: p, label: p }))} empty="It imports no repository file." />
        <PathList title="Affected modules" items={impact.affectedModules.map((m) => ({ key: m.module, label: m.module, detail: `${m.files} files` }))} empty="None." />
      </div>
    </div>
  );
}

function ImpactCard({ analysisId, request, setRequest }: { analysisId: string; request: { type: ImpactType; target: string; path?: string }; setRequest: (r: { type: ImpactType; target: string; path?: string }) => void }) {
  const [result, setResult] = useState<ImpactDto | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(e?: React.FormEvent) {
    e?.preventDefault();
    if (!request.target.trim()) return;
    setPending(true);
    setError(null);
    try {
      const params = new URLSearchParams({ type: request.type, target: request.target.trim(), ...(request.path ? { path: request.path } : {}) });
      const data = await api<{ impact: ImpactDto | null }>(`/api/analysis/${analysisId}/impact?${params}`);
      setResult(data.impact);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impact analysis failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <Card id="impact">
      <CardHeader>
        <CardTitle>Impact analysis</CardTitle>
        <CardDescription>What may break if a file, function or module changes: computed by walking the import and call graph, not guessed.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={run} className="flex flex-wrap gap-2">
          <select
            aria-label="Target type"
            value={request.type}
            onChange={(e) => setRequest({ type: e.target.value as ImpactType, target: request.target })}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            <option value="file">File</option>
            <option value="symbol">Symbol</option>
            <option value="module">Module</option>
          </select>
          <Input
            aria-label="Impact target"
            placeholder={request.type === "file" ? "src/auth/authenticate.ts" : request.type === "symbol" ? "createUser" : "src/users"}
            value={request.target}
            onChange={(e) => setRequest({ type: request.type, target: e.target.value })}
            className="min-w-0 flex-1 font-mono"
          />
          <Button type="submit" variant="outline" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Target />} Analyse
          </Button>
        </form>
        {error && <p className="text-sm text-sev-critical">{error}</p>}
        {result && <ImpactResultView impact={result} />}
      </CardContent>
    </Card>
  );
}

export function IntelligencePanel({ analysisId, summary }: { analysisId: string; summary: IntelligenceSummaryDto }) {
  const t = summary.totals;
  const [impact, setImpact] = useState<{ type: ImpactType; target: string; path?: string }>({ type: "file", target: summary.topFiles[0]?.path ?? "" });
  const pickImpact = (type: ImpactType, target: string, path?: string) => {
    setImpact({ type, target, path });
    document.getElementById("impact")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Files indexed" value={formatNumber(t.indexedFiles)} hint={`of ${formatNumber(t.files)} files · ${t.modules} modules`} />
        <Stat label="Symbols" value={formatNumber(t.symbols)} hint={`${formatNumber(t.exportedSymbols)} exported · ${formatNumber(t.resolvedReferences)} resolved calls`} />
        <Stat label="File dependencies" value={formatNumber(t.internalDependencies)} hint={`${formatNumber(t.externalPackages)} external packages · ${formatNumber(t.unresolvedDependencies)} unresolved`} />
        <Stat label="Import cycles" value={formatNumber(t.cycles)} hint="including test files" tone={t.cycles > 0 ? "alert" : undefined} />
      </div>

      <ManifestCard summary={summary} />

      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <SymbolSearch analysisId={analysisId} onImpact={pickImpact} />
        <Card>
          <CardHeader>
            <CardTitle>Most depended-upon files</CardTitle>
            <CardDescription>Ranked by PageRank over the import graph: changes here reach the most code.</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.topFiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No production file is imported by another.</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-sm">
                {summary.topFiles.slice(0, 10).map((f) => (
                  <li key={f.path} className="flex items-center gap-3">
                    <button type="button" onClick={() => pickImpact("file", f.path)} className="min-w-0 flex-1 truncate text-left font-mono text-xs text-primary hover:underline" title={`Impact of ${f.path}`}>
                      {f.path}
                    </button>
                    <span className="shrink-0 tabular-nums text-xs text-muted-foreground">{f.fanIn} importers</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <ImpactCard analysisId={analysisId} request={impact} setRequest={setImpact} />

      <div className="grid gap-6 lg:grid-cols-5 [&>*]:min-w-0">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Modules</CardTitle>
            <CardDescription>Directories at depth {summary.moduleDepth}, as in the Architecture tab, with their code and tests.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="pb-2 font-medium">Module</th>
                    <th className="pb-2 text-right font-medium">Files</th>
                    <th className="pb-2 text-right font-medium">Tests</th>
                    <th className="pb-2 text-right font-medium">Symbols</th>
                    <th className="pb-2 text-right font-medium">Exported</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.modules.slice(0, 30).map((m) => (
                    <tr key={m.key} className="border-t">
                      <td className="py-1.5 pr-3">
                        <button type="button" onClick={() => pickImpact("module", m.key)} className="font-mono text-xs text-primary hover:underline">
                          {m.key}
                        </button>
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{formatNumber(m.sourceFiles)}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatNumber(m.testFiles)}</td>
                      <td className="py-1.5 text-right tabular-nums">{formatNumber(m.symbols)}</td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">{formatNumber(m.exported)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>External packages</CardTitle>
            <CardDescription>Imported third-party packages, by number of importing files.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <PathList title="Packages" items={summary.externalPackages.map((p) => ({ key: p.name, label: p.name, detail: `${p.files} files` }))} empty="No third-party imports." />
            <PathList title="Unresolved imports" items={summary.unresolvedImports.map((u) => ({ key: `${u.path}${u.specifier}`, label: u.specifier, detail: u.path }))} empty="Every local import resolves to a file." />
            {summary.cycles.length > 0 && <PathList title="Import cycles" items={summary.cycles.map((c) => ({ key: c.files.join(), label: c.files.join(" ↔ ") }))} empty="" />}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Repository tree</CardTitle>
          <CardDescription>Files as ingested: vendored, build and cache directories, gitignored files and symlinks are excluded.</CardDescription>
        </CardHeader>
        <CardContent>
          <FileTree analysisId={analysisId} />
        </CardContent>
      </Card>

      <div className="flex items-start gap-3 rounded-lg border px-4 py-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>
          Everything on this tab is deterministic: symbols come from syntax trees ({summary.symbolLanguages.map((l) => LANGUAGE_NAMES[l] ?? l).join(", ")}), imports are resolved
          with each language&apos;s lookup rules, and impact is a graph traversal. A call is linked to its target only when imports make it unambiguous; calls through
          objects of inferred types are listed by name. Code is never executed, and secret files are never read. Indexed by {summary.analyzer} v{summary.analyzerVersion} in{" "}
          {formatNumber(summary.durationMs)} ms
          {(summary.truncated.symbols || summary.truncated.references || summary.truncated.dependencies) && "; the index reached its size limits and is incomplete"}.
        </p>
      </div>
    </div>
  );
}
