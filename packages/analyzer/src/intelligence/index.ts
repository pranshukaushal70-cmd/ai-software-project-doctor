import { lstat, readFile } from "node:fs/promises";
import { createResolver } from "../architecture/resolve";
import type { CodeAnalysis } from "../metrics";
import type { RepositoryScan } from "../scanner";
import { ANALYZER_VERSION } from "../version";
import { moduleKey, rankFiles, RepositoryGraph, type GraphEdge } from "./graph";
import { buildManifest, type RepositoryManifest } from "./manifest";
import { fileRole } from "./roles";
import type { FileSymbols, SymbolKind } from "./symbols";

export const INTELLIGENCE_ANALYZER_ID = "intelligence";

/**
 * Repository index: resolved file dependencies, symbols and call references,
 * plus the repository manifest and summary statistics. Everything here is
 * deterministic: the same repository content produces the same records.
 */

export type DependencyKind = "INTERNAL" | "EXTERNAL" | "BUILTIN" | "UNRESOLVED";

export interface FileDependencyRecord {
  from: string;
  /** Target file for INTERNAL dependencies. */
  to: string | null;
  specifier: string;
  kind: DependencyKind;
  /** Package name for EXTERNAL dependencies. */
  packageName: string | null;
}

export interface SymbolRecord {
  /** Stable within an analysis: path, qualified name and an ordinal for duplicates. */
  key: string;
  path: string;
  name: string;
  kind: SymbolKind;
  parent: string | null;
  exported: boolean;
  isDefault: boolean;
  line: number;
  endLine: number;
  signature: string | null;
}

export interface ReferenceRecord {
  path: string;
  /** Key of the enclosing symbol, null at module level. */
  fromKey: string | null;
  /** Key of the called symbol when the call resolves unambiguously, else null. */
  targetKey: string | null;
  name: string;
  receiver: string | null;
  line: number;
}

export interface IntelligenceSummary {
  analyzer: string;
  analyzerVersion: string;
  manifest: RepositoryManifest;
  /** Languages whose symbols are extracted; other languages contribute files and imports only. */
  symbolLanguages: string[];
  moduleDepth: number;
  totals: {
    files: number;
    indexedFiles: number;
    symbols: number;
    exportedSymbols: number;
    symbolsByKind: Record<string, number>;
    references: number;
    resolvedReferences: number;
    dependencies: number;
    internalDependencies: number;
    externalDependencies: number;
    builtinDependencies: number;
    unresolvedDependencies: number;
    externalPackages: number;
    cycles: number;
    modules: number;
  };
  modules: Array<{ key: string; files: number; sourceFiles: number; testFiles: number; symbols: number; exported: number }>;
  /** Most depended-upon production files by PageRank over the import graph. */
  topFiles: Array<{ path: string; fanIn: number; fanOut: number; rank: number }>;
  cycles: Array<{ files: string[] }>;
  externalPackages: Array<{ name: string; files: number }>;
  unresolvedImports: Array<{ path: string; specifier: string }>;
  truncated: { symbols: boolean; references: boolean; dependencies: boolean; filesWithTooManySymbols: number };
  durationMs: number;
}

export interface RepositoryIndex {
  dependencies: FileDependencyRecord[];
  symbols: SymbolRecord[];
  references: ReferenceRecord[];
  summary: IntelligenceSummary;
}

export interface BuildIndexOptions {
  /** Repository name for the manifest when no package manifest names it. */
  name: string;
  /** Directory depth used to group files into modules (the architecture analysis's module depth). */
  moduleDepth: number;
  maxSymbols?: number;
  maxReferences?: number;
  maxDependencies?: number;
}

const SMALL_FILE = 64 * 1024;
const RESOLVER_FILE = 512 * 1024;
const SYMBOL_LANGUAGES = ["typescript", "javascript", "python"];
/** Resolution marker for third-party and standard-library modules. */
const LIBRARY = "\0library";

export async function buildRepositoryIndex(scan: RepositoryScan, code: CodeAnalysis, extracted: readonly FileSymbols[], opts: BuildIndexOptions): Promise<RepositoryIndex> {
  const started = performance.now();
  const byPath = new Map(scan.files.map((f) => [f.path, f]));
  /** Reads small text files for configuration; never secret material, never outside the scanned file list. */
  const readText = async (rel: string, limit: number) => {
    const f = byPath.get(rel);
    if (!f || f.size > limit || f.kind === "BINARY" || fileRole(f.path, f.kind) === "secret") return null;
    const stat = await lstat(f.absPath).catch(() => null);
    if (!stat?.isFile()) return null;
    return readFile(f.absPath, "utf8").catch(() => null);
  };
  const manifest = await buildManifest(scan, { name: opts.name, read: (p) => readText(p, SMALL_FILE) });
  const resolver = await createResolver({ paths: scan.files.map((f) => f.path), read: (p) => readText(p, RESOLVER_FILE) });

  // ---------------------------------------------------------------- file dependencies
  const maxDependencies = opts.maxDependencies ?? 200_000;
  const symbolsByPath = new Map(extracted.map((f) => [f.path, f]));
  const dependencies: FileDependencyRecord[] = [];
  const seenDep = new Set<string>();
  /** path → specifier → first internal target file, LIBRARY for external/builtin modules, null when unresolved. */
  const resolution = new Map<string, Map<string, string | null>>();
  let dependenciesTruncated = false;
  for (const file of code.files) {
    const specs = new Set([...file.metrics.imports, ...(symbolsByPath.get(file.path)?.imports.map((b) => b.specifier) ?? [])]);
    const resolved = new Map<string, string | null>();
    for (const spec of specs) {
      const r = resolver.resolve(file.path, file.language, spec);
      const add = (rec: FileDependencyRecord) => {
        const id = `${rec.from}\0${rec.specifier}\0${rec.to ?? ""}`;
        if (seenDep.has(id)) return;
        if (dependencies.length >= maxDependencies) {
          dependenciesTruncated = true;
          return;
        }
        seenDep.add(id);
        dependencies.push(rec);
      };
      if (r.kind === "internal") {
        resolved.set(spec, r.targets[0] ?? null);
        for (const to of r.targets) if (to !== file.path && byPath.has(to)) add({ from: file.path, to, specifier: spec, kind: "INTERNAL", packageName: null });
      } else {
        resolved.set(spec, r.kind === "unresolved" ? null : LIBRARY);
        add({
          from: file.path,
          to: null,
          specifier: spec,
          kind: r.kind === "external" ? "EXTERNAL" : r.kind === "builtin" ? "BUILTIN" : "UNRESOLVED",
          packageName: r.kind === "external" ? r.name : null,
        });
      }
    }
    resolution.set(file.path, resolved);
  }

  // ---------------------------------------------------------------- symbols
  const maxSymbols = opts.maxSymbols ?? 100_000;
  const symbols: SymbolRecord[] = [];
  const keysByFile = new Map<string, string[]>(); // path → symbol index in file → key
  let symbolsTruncated = false;
  for (const f of extracted) {
    const ordinals = new Map<string, number>();
    const keys: string[] = [];
    for (const s of f.symbols) {
      const qualified = s.parent ? `${s.parent}.${s.name}` : s.name;
      const ordinal = ordinals.get(qualified) ?? 0;
      ordinals.set(qualified, ordinal + 1);
      const key = `${f.path}#${qualified}${ordinal ? `#${ordinal}` : ""}`;
      if (symbols.length >= maxSymbols) {
        symbolsTruncated = true;
        keys.push("");
        continue;
      }
      keys.push(key);
      symbols.push({ key, path: f.path, name: s.name, kind: s.kind, parent: s.parent, exported: s.exported, isDefault: s.isDefault, line: s.line, endLine: s.endLine, signature: s.signature });
    }
    keysByFile.set(f.path, keys);
  }

  // Per-file lookup tables for call resolution.
  const local = new Map<string, Map<string, string>>(); // path → name → key (module-level declarations first)
  const exportsOf = new Map<string, Map<string, string>>(); // path → exported name / "default" → key
  const methodsOf = new Map<string, Map<string, string[]>>(); // path → method name → keys
  for (const f of extracted) {
    const keys = keysByFile.get(f.path)!;
    const l = new Map<string, string>();
    const e = new Map<string, string>();
    const m = new Map<string, string[]>();
    f.symbols.forEach((s, i) => {
      const key = keys[i];
      if (!key) return;
      if (s.kind === "METHOD") (m.get(s.name) ?? m.set(s.name, []).get(s.name)!).push(key);
      else if (!l.has(s.name) || s.parent === null) l.set(s.name, key);
      if (s.parent === null && s.exported) e.set(s.name, key);
      if (s.isDefault) e.set("default", key);
    });
    local.set(f.path, l);
    exportsOf.set(f.path, e);
    methodsOf.set(f.path, m);
  }
  const definedNames = new Set(symbols.map((s) => s.name));

  // ---------------------------------------------------------------- references
  const maxReferences = opts.maxReferences ?? 200_000;
  const references: ReferenceRecord[] = [];
  let referencesTruncated = false;
  for (const f of extracted) {
    const keys = keysByFile.get(f.path)!;
    const bindings = new Map(f.imports.filter((b) => b.local).map((b) => [b.local, b]));
    const resolvedSpecs = resolution.get(f.path) ?? new Map<string, string | null>();
    /** Key of the called symbol; null when unknown; EXTERNAL when the call provably targets a library. */
    const EXTERNAL = "\0external";
    const targetOf = (call: FileSymbols["calls"][number]): string | null => {
      if (call.receiver === "this" || call.receiver === "self" || call.receiver === "cls") {
        const candidates = methodsOf.get(f.path)?.get(call.name) ?? [];
        return candidates.length === 1 ? candidates[0]! : null;
      }
      if (call.receiver) {
        const b = bindings.get(call.receiver);
        if (!b) return null;
        const file = resolvedSpecs.get(b.specifier);
        // `jwt.verify()` on a library import cannot be a call of repository code.
        if (file === LIBRARY) return EXTERNAL;
        if (!file) return null;
        // `ns.fn()` on an imported namespace or Python module.
        return b.imported === "*" ? (exportsOf.get(file)?.get(call.name) ?? null) : null;
      }
      const b = bindings.get(call.name);
      if (b) {
        const file = resolvedSpecs.get(b.specifier);
        if (file === LIBRARY) return EXTERNAL;
        if (!file || b.imported === "*") return null;
        return exportsOf.get(file)?.get(b.imported) ?? null;
      }
      return local.get(f.path)?.get(call.name) ?? null;
    };
    for (const call of f.calls) {
      const target = targetOf(call);
      // Calls of library code, and of names defined nowhere in the repository, are not indexed.
      if (target === EXTERNAL || (!target && !definedNames.has(call.name))) continue;
      const targetKey = target;
      if (references.length >= maxReferences) {
        referencesTruncated = true;
        break;
      }
      references.push({
        path: f.path,
        fromKey: call.enclosing >= 0 ? keys[call.enclosing] || null : null,
        targetKey,
        name: call.name,
        receiver: call.receiver,
        line: call.line,
      });
    }
  }

  // ---------------------------------------------------------------- summary
  const files = scan.files.map((f) => ({ id: f.path, path: f.path, kind: f.kind }));
  const internal: GraphEdge[] = dependencies.filter((d) => d.kind === "INTERNAL" && d.to).map((d) => ({ from: d.from, to: d.to! }));
  const graph = new RepositoryGraph({ files, edges: internal, moduleDepth: opts.moduleDepth });
  const sourceIds = scan.files.filter((f) => f.kind === "SOURCE").map((f) => f.path);
  const sourceSet = new Set(sourceIds);
  const sourceEdges = internal.filter((e) => sourceSet.has(e.from) && sourceSet.has(e.to));
  const rank = rankFiles(sourceIds, sourceEdges);
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const e of sourceEdges) {
    fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1);
    fanOut.set(e.from, (fanOut.get(e.from) ?? 0) + 1);
  }

  const modules = new Map<string, IntelligenceSummary["modules"][number]>();
  for (const f of scan.files) {
    if (f.kind !== "SOURCE" && f.kind !== "TEST") continue;
    const key = moduleKey(f.path, opts.moduleDepth);
    const m = modules.get(key) ?? { key, files: 0, sourceFiles: 0, testFiles: 0, symbols: 0, exported: 0 };
    m.files++;
    if (f.kind === "SOURCE") m.sourceFiles++;
    else m.testFiles++;
    modules.set(key, m);
  }
  for (const s of symbols) {
    const m = modules.get(moduleKey(s.path, opts.moduleDepth));
    if (!m) continue;
    m.symbols++;
    if (s.exported) m.exported++;
  }

  const externalPackages = new Map<string, Set<string>>();
  for (const d of dependencies) if (d.kind === "EXTERNAL" && d.packageName) (externalPackages.get(d.packageName) ?? externalPackages.set(d.packageName, new Set()).get(d.packageName)!).add(d.from);
  const symbolsByKind: Record<string, number> = {};
  for (const s of symbols) symbolsByKind[s.kind] = (symbolsByKind[s.kind] ?? 0) + 1;
  const count = (k: DependencyKind) => dependencies.filter((d) => d.kind === k).length;
  const cycles = graph.cycles();

  return {
    dependencies,
    symbols,
    references,
    summary: {
      analyzer: INTELLIGENCE_ANALYZER_ID,
      analyzerVersion: ANALYZER_VERSION,
      manifest,
      symbolLanguages: SYMBOL_LANGUAGES,
      moduleDepth: opts.moduleDepth,
      totals: {
        files: scan.files.length,
        indexedFiles: extracted.length,
        symbols: symbols.length,
        exportedSymbols: symbols.filter((s) => s.exported).length,
        symbolsByKind,
        references: references.length,
        resolvedReferences: references.filter((r) => r.targetKey).length,
        dependencies: dependencies.length,
        internalDependencies: count("INTERNAL"),
        externalDependencies: count("EXTERNAL"),
        builtinDependencies: count("BUILTIN"),
        unresolvedDependencies: count("UNRESOLVED"),
        externalPackages: externalPackages.size,
        cycles: cycles.length,
        modules: modules.size,
      },
      modules: [...modules.values()].sort((a, b) => b.files - a.files || a.key.localeCompare(b.key)).slice(0, 200),
      topFiles: sourceIds
        .map((path) => ({ path, fanIn: fanIn.get(path) ?? 0, fanOut: fanOut.get(path) ?? 0, rank: Math.round((rank.get(path) ?? 0) * 1e6) / 1e6 }))
        .filter((f) => f.fanIn > 0)
        .sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path))
        .slice(0, 20),
      cycles: cycles.slice(0, 20).map((files) => ({ files: files.slice(0, 50) })),
      externalPackages: [...externalPackages]
        .map(([name, set]) => ({ name, files: set.size }))
        .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
        .slice(0, 30),
      unresolvedImports: dependencies
        .filter((d) => d.kind === "UNRESOLVED")
        .slice(0, 50)
        .map((d) => ({ path: d.from, specifier: d.specifier })),
      truncated: {
        symbols: symbolsTruncated,
        references: referencesTruncated,
        dependencies: dependenciesTruncated,
        filesWithTooManySymbols: extracted.filter((f) => f.truncated).length,
      },
      durationMs: Math.round(performance.now() - started),
    },
  };
}

export { createSymbolCollector, extractSymbols, SYMBOL_KINDS, type FileSymbols, type SymbolKind, type ExtractedSymbol, type ImportBinding, type CallSite } from "./symbols";
export { fileRole, FILE_ROLES, type FileRole } from "./roles";
export { buildManifest, type RepositoryManifest, type RuntimeVersion } from "./manifest";
export {
  RepositoryGraph,
  rankFiles,
  moduleKey,
  testStem,
  tokenize,
  type GraphFile,
  type GraphEdge,
  type GraphSymbol,
  type GraphReference,
  type GraphRoute,
  type ImpactTarget,
  type ImpactResult,
  type ImpactOptions,
  type SearchHit,
  type SymbolRef,
} from "./graph";
