import { tokenize, type GraphRoute, type RepositoryGraph, type RepositoryManifest } from "@pd/analyzer/intelligence";
import type { Evidence, EvidenceKind, PlanningContext, TaskInput } from "./schema";

/**
 * Deterministic context retrieval: turns a developer task into a bounded bundle of
 * numbered evidence items using the Phase 6 repository index (keyword search, impact
 * analysis, related tests and configuration, imports, findings). The planner sees
 * only this bundle: paths, names, routes and one-line summaries, never file contents.
 * Same task + same index → same bundle.
 */

export interface ContextSources {
  graph: RepositoryGraph;
  manifest: RepositoryManifest | null;
  repositoryName: string;
  routes: readonly GraphRoute[];
  /** Existing findings of the analysis (redacted evidence), most severe first. */
  findings: ReadonlyArray<{ ruleId: string; title: string; severity: string; path: string | null; line: number | null }>;
  /** Third-party packages imported by each file (FileDependency rows of kind EXTERNAL). */
  externalImports: ReadonlyArray<{ path: string; packageName: string }>;
}

export const CONTEXT_LIMITS = {
  searchHits: 60,
  candidateFiles: 12,
  impactFiles: 5,
  impactDepth: 2,
  dependentsPerFile: 6,
  importsPerFile: 6,
  symbols: 40,
  tests: 12,
  routes: 12,
  configs: 10,
  packages: 15,
  findings: 20,
  evidence: 150,
} as const;

export function buildPlanningContext(task: TaskInput, src: ContextSources): PlanningContext {
  const L = CONTEXT_LIMITS;
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const add = (kind: EvidenceKind, e: Omit<Evidence, "id" | "kind">, key = `${kind}|${e.path}|${e.symbol}|${e.line}|${e.summary}`) => {
    if (seen.has(key)) return;
    if (evidence.length >= L.evidence) {
      truncated = true;
      return;
    }
    seen.add(key);
    evidence.push({ id: `E${evidence.length + 1}`, kind, ...e });
  };
  const scope = task.scope?.replace(/\/+$/, "") || null;
  const inScope = (path: string | null) => !scope || (path !== null && (path === scope || path.startsWith(`${scope}/`)));
  const m = src.manifest;

  // 1. Repository facts and conventions.
  if (m) {
    add("MANIFEST", {
      path: null,
      symbol: null,
      line: null,
      source: "manifest",
      summary: `Languages: ${m.languages.map((l) => `${l.language} ${l.share}%`).join(", ") || "none"}; frameworks: ${m.frameworks.map((f) => f.name).join(", ") || "none"}; runtimes: ${m.runtimes.map((r) => `${r.name} ${r.version}`).join(", ") || "unknown"}.`,
    });
    add("MANIFEST", {
      path: null,
      symbol: null,
      line: null,
      source: "manifest",
      summary: `Tests: ${m.testFrameworks.map((f) => `${f.name} (${f.evidence})`).join(", ") || "no test framework detected"}; test directories: ${m.testDirs.map((d) => d.path).join(", ") || "none"}; source directories: ${m.sourceDirs.map((d) => d.path).slice(0, 8).join(", ") || "none"}.`,
    });
  }

  // 2. Keyword search over symbols, files and routes.
  const query = [task.request, ...(task.constraints ?? [])].join(" ");
  const hits = src.graph.search(query, L.searchHits).filter((h) => inScope(h.path));
  const fileScore = new Map<string, number>();
  for (const h of hits) fileScore.set(h.path, (fileScore.get(h.path) ?? 0) + h.score);
  const candidates = [...fileScore]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, L.candidateFiles)
    .map(([path]) => path)
    .filter((p) => src.graph.fileByPath(p));
  for (const path of candidates) {
    const f = src.graph.fileByPath(path)!;
    const names = hits.filter((h) => h.path === path && h.type === "symbol").map((h) => h.name).slice(0, 5);
    add("FILE", { path, symbol: null, line: null, source: "search", summary: `${f.kind.toLowerCase()} file matching the task${names.length ? `; declares ${names.join(", ")}` : ""}.` }, `FILE|${path}`);
  }
  let symbols = 0;
  for (const h of hits) {
    if (h.type !== "symbol" || symbols >= L.symbols) continue;
    symbols++;
    add("SYMBOL", { path: h.path, symbol: h.name, line: h.line, source: "search", summary: `${h.detail} ${h.name} is declared in ${h.path}:${h.line}.` });
  }
  let routes = 0;
  const routeHits = new Set(hits.filter((h) => h.type === "route").map((h) => `${h.name}|${h.path}`));
  for (const r of src.routes) {
    if (routes >= L.routes) break;
    if (!routeHits.has(`${r.method} ${r.path}|${r.file}`) && !candidates.includes(r.file)) continue;
    routes++;
    add("ROUTE", { path: r.file, symbol: `${r.method} ${r.path}`, line: r.line, source: "routes", summary: `${r.framework} route ${r.method} ${r.path} is declared in ${r.file}:${r.line}.` });
  }

  // 3. Structure around the most relevant files: imports, dependants, tests, configuration.
  let tests = 0;
  let configs = 0;
  for (const path of candidates.slice(0, L.impactFiles)) {
    for (const dep of src.graph.imports(path).slice(0, L.importsPerFile)) {
      add("IMPORT", { path, symbol: null, line: null, source: "imports", summary: `${path} imports ${dep}.` });
    }
    const impact = src.graph.impact({ type: "file", path }, { depth: L.impactDepth, limit: 50 });
    for (const d of impact.directDependents.slice(0, L.dependentsPerFile)) {
      add("IMPORT", { path: d, symbol: null, line: null, source: "impact", summary: `${d} imports ${path} (a change to ${path} reaches it).` });
    }
    for (const t of impact.relatedTests) {
      if (tests >= L.tests) break;
      tests++;
      add(
        "TEST",
        { path: t.path, symbol: null, line: null, source: "related-tests", summary: t.reason === "imports" ? `Test ${t.path} reaches ${path} through imports (distance ${t.depth}).` : `Test ${t.path} is named after ${path}.` },
        `TEST|${t.path}`,
      );
    }
    for (const c of impact.relatedConfig) {
      if (configs >= L.configs) break;
      configs++;
      add("CONFIG", { path: c.path, symbol: null, line: null, source: "related-config", summary: `${c.path}: ${c.reason} for ${path}.` }, `CONFIG|${c.path}`);
    }
  }

  // 4. Packages: those the relevant files import, and those whose names match the task.
  const words = new Set(tokenize(query));
  const candidateSet = new Set(candidates);
  const packages = new Map<string, Set<string>>();
  for (const e of src.externalImports) {
    const relevant = candidateSet.has(e.path) || tokenize(e.packageName).some((t) => words.has(t));
    if (!relevant) continue;
    (packages.get(e.packageName) ?? packages.set(e.packageName, new Set()).get(e.packageName)!).add(e.path);
  }
  for (const [name, files] of [...packages].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).slice(0, L.packages)) {
    const list = [...files].sort();
    add("PACKAGE", { path: list[0] ?? null, symbol: name, line: null, source: "imports", summary: `Package ${name} is imported by ${list.slice(0, 3).join(", ")}${list.length > 3 ? ` and ${list.length - 3} more` : ""}.` });
  }

  // 5. Existing findings in those files, or about the same topic.
  let findings = 0;
  for (const f of src.findings) {
    if (findings >= L.findings) break;
    const onFile = f.path !== null && candidateSet.has(f.path);
    const onTopic = tokenize(`${f.title} ${f.ruleId}`).some((t) => words.has(t));
    if (!(onFile || onTopic) || !inScope(f.path)) continue;
    findings++;
    add("FINDING", { path: f.path, symbol: f.ruleId, line: f.line, source: "findings", summary: `${f.severity} finding "${f.title}" (${f.ruleId})${f.path ? ` in ${f.path}${f.line ? `:${f.line}` : ""}` : ""}.` });
  }

  return {
    task: { request: task.request, scope, constraints: task.constraints ?? [] },
    repository: {
      name: src.repositoryName,
      primaryLanguage: m?.primaryLanguage ?? null,
      languages: m?.languages.map((l) => l.language) ?? [],
      frameworks: m?.frameworks.map((f) => f.name) ?? [],
      testFrameworks: m?.testFrameworks.map((f) => f.name) ?? [],
      packageManagers: m?.packageManagers.map((p) => p.name) ?? [],
      runtimes: m?.runtimes.map((r) => `${r.name} ${r.version}`) ?? [],
    },
    evidence,
    stats: { searchHits: hits.length, candidateFiles: candidates.length, evidence: evidence.length, truncated },
  };
}
