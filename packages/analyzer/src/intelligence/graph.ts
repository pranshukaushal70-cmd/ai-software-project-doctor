import { stronglyConnectedComponents } from "../architecture/graph";
import type { FileKind } from "../scanner";
import { fileRole, type FileRole } from "./roles";
import type { SymbolKind } from "./symbols";

/**
 * Deterministic query engine over a repository index: file import graph,
 * symbols and call references. Built in memory from the stored rows (no file
 * contents), it answers "who imports X", "who calls Y", "what is affected if Z
 * changes" by graph traversal. No LLM and no heuristics beyond those documented
 * on each result.
 */

export interface GraphFile {
  id: string;
  path: string;
  kind: FileKind;
}
/** A resolved import from one repository file to another (file ids). */
export interface GraphEdge {
  from: string;
  to: string;
}
export interface GraphSymbol {
  id: string;
  fileId: string;
  name: string;
  kind: SymbolKind;
  parent: string | null;
  exported: boolean;
  line: number;
  endLine: number;
  signature: string | null;
}
export interface GraphReference {
  fileId: string;
  fromSymbolId: string | null;
  targetSymbolId: string | null;
  name: string;
  receiver: string | null;
  line: number;
}
export interface GraphRoute {
  method: string;
  path: string;
  file: string;
  line: number;
  framework: string;
}

export interface RepositoryGraphInput {
  files: readonly GraphFile[];
  edges: readonly GraphEdge[];
  symbols?: readonly GraphSymbol[];
  references?: readonly GraphReference[];
  routes?: readonly GraphRoute[];
  /** Directory depth that groups files into modules (the architecture module depth). */
  moduleDepth?: number;
}

export interface SymbolRef {
  id: string;
  name: string;
  kind: SymbolKind;
  parent: string | null;
  path: string;
  line: number;
  exported: boolean;
}

export type ImpactTarget = { type: "file"; path: string } | { type: "symbol"; name: string; path?: string } | { type: "module"; module: string };

export interface ImpactOptions {
  /** Maximum import-graph distance for transitive dependants (default 10). */
  depth?: number;
  /** Maximum files listed per section (default 500). */
  limit?: number;
}

export interface ImpactResult {
  target: { type: ImpactTarget["type"]; value: string; files: string[]; symbols: SymbolRef[]; found: boolean };
  /** Files the target imports (for a symbol: its defining file's imports). */
  dependencies: string[];
  /** Files that import the target directly. */
  directDependents: string[];
  /** Every file that depends on the target through imports (or calls, for a symbol), with its distance. */
  transitiveDependents: Array<{ path: string; depth: number }>;
  /** Call sites of a symbol target: resolved ones are certain, `nameOnly` ones only share the name. */
  callers: Array<{ path: string; line: number; caller: string | null; resolved: boolean }>;
  relatedTests: Array<{ path: string; reason: "imports" | "name"; depth: number | null }>;
  relatedRoutes: GraphRoute[];
  relatedConfig: Array<{ path: string; reason: string }>;
  affectedModules: Array<{ module: string; files: number }>;
  truncated: boolean;
}

export interface SearchHit {
  type: "symbol" | "file" | "route";
  score: number;
  path: string;
  line: number | null;
  name: string;
  detail: string;
}

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function moduleKey(path: string, depth: number): string {
  const segs = dirOf(path).split("/").filter(Boolean);
  return segs.length === 0 ? "." : segs.slice(0, depth).join("/");
}

/** Name a test file is about: `orders.test.ts` → orders, `test_orders.py` → orders, `OrdersTest.java` → orders. */
export function testStem(path: string): string {
  return baseOf(path)
    .replace(/\.[^.]+$/, "")
    .replace(/\.(?:test|spec|e2e|cy)$/i, "")
    .replace(/^test_|_test$/i, "")
    .replace(/(?<=\w)Tests?$/, "")
    .toLowerCase();
}
const sourceStem = (path: string) => {
  const stem = baseOf(path).replace(/\.[^.]+$/, "").toLowerCase();
  return /^(?:index|__init__|mod|main)$/.test(stem) ? baseOf(dirOf(path)).toLowerCase() : stem;
};

/** Words of a question that say what to do rather than what to look for. */
const QUERY_STOP_WORDS = new Set(
  "find where what which who show list get me all the of for in on to and or is are a an how does do defined definition implementation implemented implements code function functions method methods file files class classes used uses using called calls".split(" "),
);

/** Words of an identifier or path: `createUserSession` → create, user, session. */
export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * PageRank over the import graph (dependants pass rank to what they import), so
 * files many important files depend on rank highest. Deterministic: fixed
 * iterations, ties broken by path.
 */
export function rankFiles(fileIds: readonly string[], edges: readonly GraphEdge[], iterations = 20): Map<string, number> {
  const n = fileIds.length;
  const index = new Map(fileIds.map((id, i) => [id, i]));
  const out = fileIds.map(() => [] as number[]);
  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a !== undefined && b !== undefined && a !== b) out[a]!.push(b);
  }
  let rank = new Array<number>(n).fill(1 / Math.max(n, 1));
  const d = 0.85;
  for (let it = 0; it < iterations; it++) {
    const next = new Array<number>(n).fill((1 - d) / Math.max(n, 1));
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (out[i]!.length === 0) dangling += rank[i]!;
      else for (const j of out[i]!) next[j]! += (d * rank[i]!) / out[i]!.length;
    }
    for (let i = 0; i < n; i++) next[i]! += (d * dangling) / Math.max(n, 1);
    rank = next;
  }
  return new Map(fileIds.map((id, i) => [id, rank[i]!]));
}

export class RepositoryGraph {
  readonly files: ReadonlyMap<string, GraphFile>;
  private readonly byPath = new Map<string, GraphFile>();
  private readonly outEdges = new Map<string, Set<string>>();
  private readonly inEdges = new Map<string, Set<string>>();
  private readonly symbols: readonly GraphSymbol[];
  private readonly symbolById = new Map<string, GraphSymbol>();
  private readonly symbolsByName = new Map<string, GraphSymbol[]>();
  private readonly refsByTarget = new Map<string, GraphReference[]>();
  private readonly refsByName = new Map<string, GraphReference[]>();
  private readonly routes: readonly GraphRoute[];
  readonly moduleDepth: number;

  constructor(input: RepositoryGraphInput) {
    this.files = new Map(input.files.map((f) => [f.id, f]));
    for (const f of input.files) this.byPath.set(f.path, f);
    for (const e of input.edges) {
      if (!this.files.has(e.from) || !this.files.has(e.to) || e.from === e.to) continue;
      (this.outEdges.get(e.from) ?? this.outEdges.set(e.from, new Set()).get(e.from)!).add(e.to);
      (this.inEdges.get(e.to) ?? this.inEdges.set(e.to, new Set()).get(e.to)!).add(e.from);
    }
    this.symbols = input.symbols ?? [];
    for (const s of this.symbols) {
      this.symbolById.set(s.id, s);
      const key = s.name.toLowerCase();
      (this.symbolsByName.get(key) ?? this.symbolsByName.set(key, []).get(key)!).push(s);
    }
    for (const r of input.references ?? []) {
      if (r.targetSymbolId) (this.refsByTarget.get(r.targetSymbolId) ?? this.refsByTarget.set(r.targetSymbolId, []).get(r.targetSymbolId)!).push(r);
      (this.refsByName.get(r.name) ?? this.refsByName.set(r.name, []).get(r.name)!).push(r);
    }
    this.routes = input.routes ?? [];
    this.moduleDepth = input.moduleDepth ?? 1;
  }

  fileByPath(path: string): GraphFile | undefined {
    return this.byPath.get(path);
  }

  private path(id: string) {
    return this.files.get(id)!.path;
  }

  private sortedPaths(ids: Iterable<string>): string[] {
    return [...ids].map((id) => this.path(id)).sort();
  }

  /** Files `path` imports. */
  imports(path: string): string[] {
    const f = this.byPath.get(path);
    return f ? this.sortedPaths(this.outEdges.get(f.id) ?? []) : [];
  }

  /** Files that import `path`. */
  importers(path: string): string[] {
    const f = this.byPath.get(path);
    return f ? this.sortedPaths(this.inEdges.get(f.id) ?? []) : [];
  }

  /**
   * Breadth-first traversal from `start` along imports (`out`: what they import) or
   * dependants (`in`: who imports them). Returns each reached file with its distance;
   * the start files are not included.
   */
  traverse(start: Iterable<string>, direction: "in" | "out", maxDepth: number, limit = Infinity): { reached: Map<string, number>; truncated: boolean } {
    const edges = direction === "in" ? this.inEdges : this.outEdges;
    const reached = new Map<string, number>();
    const seen = new Set(start);
    let frontier = [...seen].sort();
    let truncated = false;
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const n of [...(edges.get(id) ?? [])].sort()) {
          if (seen.has(n)) continue;
          if (reached.size >= limit) {
            truncated = true;
            break;
          }
          seen.add(n);
          reached.set(n, depth);
          next.push(n);
        }
      }
      frontier = next;
    }
    return { reached, truncated };
  }

  /** Import cycles among the given files (all files when omitted), each as sorted paths. */
  cycles(): string[][] {
    const ids = [...this.files.keys()].sort();
    const index = new Map(ids.map((id, i) => [id, i]));
    const adj = ids.map((id) => [...(this.outEdges.get(id) ?? [])].map((t) => index.get(t)!).sort((a, b) => a - b));
    return stronglyConnectedComponents(adj)
      .filter((c) => c.length > 1)
      .map((c) => c.map((i) => this.path(ids[i]!)).sort())
      .sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
  }

  private symbolRef(s: GraphSymbol): SymbolRef {
    return { id: s.id, name: s.name, kind: s.kind, parent: s.parent, path: this.path(s.fileId), line: s.line, exported: s.exported };
  }

  /** Definitions of `name` (case-sensitive match first, then case-insensitive), optionally in one file. */
  findSymbols(name: string, path?: string): SymbolRef[] {
    const all = this.symbolsByName.get(name.toLowerCase()) ?? [];
    const exact = all.filter((s) => s.name === name);
    return (exact.length > 0 ? exact : all)
      .filter((s) => !path || this.path(s.fileId) === path)
      .map((s) => this.symbolRef(s))
      .sort((a, b) => Number(b.exported) - Number(a.exported) || a.path.localeCompare(b.path) || a.line - b.line);
  }

  /** Call sites of a symbol: resolved references first, then calls that only share its name. */
  callers(symbolId: string): ImpactResult["callers"] {
    const s = this.symbolById.get(symbolId);
    if (!s) return [];
    const resolved = this.refsByTarget.get(symbolId) ?? [];
    const resolvedKeys = new Set(resolved.map((r) => `${r.fileId}:${r.line}`));
    const caller = (r: GraphReference) => {
      const from = r.fromSymbolId ? this.symbolById.get(r.fromSymbolId) : undefined;
      return from ? (from.parent ? `${from.parent}.${from.name}` : from.name) : null;
    };
    const nameOnly = (this.refsByName.get(s.name) ?? []).filter((r) => !r.targetSymbolId && !resolvedKeys.has(`${r.fileId}:${r.line}`));
    return [
      ...resolved.map((r) => ({ path: this.path(r.fileId), line: r.line, caller: caller(r), resolved: true })),
      ...nameOnly.map((r) => ({ path: this.path(r.fileId), line: r.line, caller: caller(r), resolved: false })),
    ].sort((a, b) => Number(b.resolved) - Number(a.resolved) || a.path.localeCompare(b.path) || a.line - b.line);
  }

  /** Test files that import any of `fileIds` within `depth` hops, plus tests named after them. */
  relatedTests(fileIds: Iterable<string>, depth = 3): ImpactResult["relatedTests"] {
    const ids = new Set(fileIds);
    const out = new Map<string, ImpactResult["relatedTests"][number]>();
    for (const [id, d] of this.traverse(ids, "in", depth).reached) {
      const f = this.files.get(id)!;
      if (f.kind === "TEST") out.set(f.path, { path: f.path, reason: "imports", depth: d });
    }
    for (const id of ids) {
      const f = this.files.get(id);
      if (f?.kind === "TEST") continue;
      const stem = f && sourceStem(f.path);
      if (!stem) continue;
      for (const t of this.files.values()) {
        if (t.kind === "TEST" && !out.has(t.path) && testStem(t.path) === stem) out.set(t.path, { path: t.path, reason: "name", depth: null });
      }
    }
    return [...out.values()].sort((a, b) => (a.depth ?? 99) - (b.depth ?? 99) || a.path.localeCompare(b.path));
  }

  impact(target: ImpactTarget, opts: ImpactOptions = {}): ImpactResult {
    const depth = opts.depth ?? 10;
    const limit = opts.limit ?? 500;
    let targetFiles: string[] = [];
    let symbols: SymbolRef[] = [];
    let value: string;
    let callers: ImpactResult["callers"] = [];

    if (target.type === "file") {
      value = target.path;
      const f = this.byPath.get(target.path);
      targetFiles = f ? [f.id] : [];
    } else if (target.type === "module") {
      value = target.module;
      targetFiles = [...this.files.values()].filter((f) => moduleKey(f.path, this.moduleDepth) === target.module || f.path.startsWith(`${target.module}/`)).map((f) => f.id);
    } else {
      value = target.name;
      symbols = this.findSymbols(target.name, target.path);
      targetFiles = [...new Set(symbols.map((s) => this.byPath.get(s.path)!.id))];
      callers = symbols.flatMap((s) => this.callers(s.id));
    }

    const found = targetFiles.length > 0;
    const targetSet = new Set(targetFiles);
    const deps = new Set<string>();
    for (const id of targetFiles) for (const t of this.outEdges.get(id) ?? []) if (!targetSet.has(t)) deps.add(t);
    const importersOfTarget = new Set<string>();
    for (const id of targetFiles) for (const s of this.inEdges.get(id) ?? []) if (!targetSet.has(s)) importersOfTarget.add(s);
    let direct = importersOfTarget;
    if (target.type === "symbol") {
      // A symbol's dependants are the files calling it: resolved calls, and same-name calls in files importing its file.
      // Only when no call is visible (dynamic use, re-exports) does every importer of the defining file count.
      const calling = new Set<string>();
      for (const c of callers) {
        const id = this.byPath.get(c.path)!.id;
        if (!targetSet.has(id) && (c.resolved || importersOfTarget.has(id))) calling.add(id);
      }
      if (calling.size > 0) direct = calling;
    }

    // File/module: everything that reaches the target through imports. Symbol: the calling files (distance 1)
    // and everything that reaches them (distance + 1).
    const reached = new Map<string, number>();
    let truncated: boolean;
    if (target.type === "symbol") {
      for (const id of direct) reached.set(id, 1);
      const t = this.traverse(direct, "in", Math.max(0, depth - 1), limit);
      for (const [id, d] of t.reached) if (!reached.has(id)) reached.set(id, d + 1);
      truncated = t.truncated;
    } else {
      const t = this.traverse(targetFiles, "in", depth, limit);
      for (const [id, d] of t.reached) reached.set(id, d);
      truncated = t.truncated;
    }
    for (const id of targetSet) reached.delete(id);
    const affected = new Set([...targetSet, ...reached.keys()]);

    const affectedPaths = new Set([...affected].map((id) => this.path(id)));
    const relatedRoutes = this.routes.filter((r) => affectedPaths.has(r.file)).sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

    const modules = new Map<string, number>();
    for (const id of affected) {
      const m = moduleKey(this.path(id), this.moduleDepth);
      modules.set(m, (modules.get(m) ?? 0) + 1);
    }

    return {
      target: { type: target.type, value, files: this.sortedPaths(targetFiles), symbols, found },
      dependencies: this.sortedPaths(deps).slice(0, limit),
      directDependents: this.sortedPaths(direct).slice(0, limit),
      transitiveDependents: [...reached]
        .map(([id, d]) => ({ path: this.path(id), depth: d }))
        .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
        .slice(0, limit),
      callers: callers.slice(0, limit),
      relatedTests: found ? this.relatedTests(targetFiles, depth).slice(0, limit) : [],
      relatedRoutes,
      relatedConfig: found ? this.relatedConfig(targetFiles) : [],
      affectedModules: [...modules].map(([module, files]) => ({ module, files })).sort((a, b) => b.files - a.files || a.module.localeCompare(b.module)),
      truncated: truncated || reached.size > limit,
    };
  }

  /**
   * Configuration that governs the target files: the nearest manifest (and its
   * lockfile) in each file's directory or above, and configuration files in the
   * same directory. Path-based only; configuration contents are not inspected.
   */
  relatedConfig(fileIds: Iterable<string>): ImpactResult["relatedConfig"] {
    const out = new Map<string, string>();
    const roleOf = new Map<string, FileRole>();
    const byDir = new Map<string, GraphFile[]>();
    for (const f of this.files.values()) {
      const role = fileRole(f.path, f.kind);
      if (role !== "manifest" && role !== "lockfile" && role !== "config") continue;
      roleOf.set(f.path, role);
      const d = dirOf(f.path);
      (byDir.get(d) ?? byDir.set(d, []).get(d)!).push(f);
    }
    for (const id of fileIds) {
      const path = this.path(id);
      for (const c of byDir.get(dirOf(path)) ?? []) if (roleOf.get(c.path) === "config") out.set(c.path, "configuration in the same directory");
      let dir = dirOf(path);
      for (;;) {
        const manifests = (byDir.get(dir) ?? []).filter((c) => roleOf.get(c.path) !== "config");
        if (manifests.some((c) => roleOf.get(c.path) === "manifest")) {
          for (const m of manifests) if (!out.has(m.path)) out.set(m.path, roleOf.get(m.path) === "manifest" ? "nearest package manifest" : "lockfile of that manifest");
          break;
        }
        if (dir === "") break;
        dir = dirOf(dir);
      }
    }
    return [...out].map(([path, reason]) => ({ path, reason })).sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Keyword search over symbol names, file paths and API routes. Scores whole-word
   * matches above partial ones and exported symbols above private ones; deterministic
   * ordering. This is lexical matching, not semantic understanding.
   */
  search(query: string, limit = 25): SearchHit[] {
    const terms = [...new Set(tokenize(query))].filter((t) => !QUERY_STOP_WORDS.has(t));
    if (terms.length === 0) return [];
    /** 3 for the same word, 2.5 for the same stem (authentication ~ authenticate), 1 for a prefix (auth ~ authenticate). */
    const similarity = (a: string, b: string) => {
      if (a === b) return 3;
      let p = 0;
      while (p < a.length && p < b.length && a[p] === b[p]) p++;
      if (p >= 5 && p >= 0.7 * Math.min(a.length, b.length)) return 2.5;
      return a.startsWith(b) || b.startsWith(a) ? 1 : 0;
    };
    const scoreTokens = (tokens: string[]) => {
      let score = 0;
      for (const t of terms) score += tokens.reduce((best, x) => Math.max(best, similarity(t, x)), 0);
      return score;
    };
    const hits: SearchHit[] = [];
    for (const s of this.symbols) {
      const path = this.path(s.fileId);
      const score = scoreTokens(tokenize(s.name)) * 2 + scoreTokens(tokenize(path)) * 0.5 + (s.exported ? 0.5 : 0);
      if (score >= 2) hits.push({ type: "symbol", score, path, line: s.line, name: s.parent ? `${s.parent}.${s.name}` : s.name, detail: s.kind.toLowerCase() });
    }
    for (const f of this.files.values()) {
      if (f.kind !== "SOURCE" && f.kind !== "TEST") continue;
      const score = scoreTokens(tokenize(f.path));
      if (score >= 3) hits.push({ type: "file", score, path: f.path, line: null, name: baseOf(f.path), detail: f.kind.toLowerCase() });
    }
    for (const r of this.routes) {
      const score = scoreTokens(tokenize(r.path)) * 1.5;
      if (score >= 3) hits.push({ type: "route", score, path: r.file, line: r.line, name: `${r.method} ${r.path}`, detail: r.framework });
    }
    return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0) || a.name.localeCompare(b.name)).slice(0, limit);
  }
}
