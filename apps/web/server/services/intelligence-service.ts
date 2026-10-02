import "server-only";
import { RepositoryGraph, type GraphRoute, type ImpactResult, type ImpactTarget, type IntelligenceSummary } from "@pd/analyzer/intelligence";
import { getPrisma, type Prisma } from "@pd/db";
import type { ContextRequest, ImpactQuery, ImportsQuery, ReferencesQuery, SymbolsQuery } from "@pd/shared";
import type { getOwnedAnalysis } from "./analysis-service";

/**
 * Repository intelligence queries over a stored analysis: symbols, call references,
 * file imports and impact analysis. Everything is computed from the index rows the
 * worker stored (no file contents, no LLM) and is deterministic.
 */

type OwnedAnalysis = Awaited<ReturnType<typeof getOwnedAnalysis>>;

interface StoredSummary {
  intelligence?: IntelligenceSummary;
  practices?: { api?: { list?: GraphRoute[] } };
  architecture?: { modules?: Array<{ key: string; fanIn: number; fanOut: number; instability: number; inCycle: boolean; layer: string | null }> };
}

export const summaryOf = (a: OwnedAnalysis) => (a.summary ?? {}) as StoredSummary;
/** Analyses made before analyzer 0.6.0 have no index; endpoints then answer `indexed: false`. */
export const isIndexed = (a: OwnedAnalysis) => a.status === "COMPLETED" && !!summaryOf(a).intelligence;

// ---------------------------------------------------------------- graph cache

/**
 * Completed analyses never change, so the in-memory query graph built from their rows
 * can be reused. Small and bounded: the graph holds ids, paths and names, never file contents.
 */
const CACHE_SIZE = 4;
const graphs = new Map<string, Promise<RepositoryGraph>>();

async function loadGraph(a: OwnedAnalysis): Promise<RepositoryGraph> {
  const prisma = getPrisma();
  const analysisId = a.id;
  const [files, edges, symbols, references] = await Promise.all([
    prisma.file.findMany({ where: { analysisId }, select: { id: true, path: true, kind: true } }),
    prisma.fileDependency.findMany({ where: { analysisId, kind: "INTERNAL" }, select: { fromFileId: true, toFileId: true } }),
    prisma.codeSymbol.findMany({
      where: { analysisId },
      select: { id: true, fileId: true, name: true, kind: true, parent: true, exported: true, line: true, endLine: true, signature: true },
    }),
    prisma.symbolReference.findMany({ where: { analysisId }, select: { fileId: true, fromSymbolId: true, targetSymbolId: true, name: true, receiver: true, line: true } }),
  ]);
  const summary = summaryOf(a);
  return new RepositoryGraph({
    files,
    edges: edges.filter((e) => e.toFileId).map((e) => ({ from: e.fromFileId, to: e.toFileId! })),
    symbols,
    references,
    routes: summary.practices?.api?.list ?? [],
    moduleDepth: summary.intelligence?.moduleDepth ?? 1,
  });
}

export function graphFor(a: OwnedAnalysis): Promise<RepositoryGraph> {
  const cached = graphs.get(a.id);
  if (cached) {
    // Refresh recency.
    graphs.delete(a.id);
    graphs.set(a.id, cached);
    return cached;
  }
  const loading = loadGraph(a);
  graphs.set(a.id, loading);
  loading.catch(() => graphs.delete(a.id));
  while (graphs.size > CACHE_SIZE) graphs.delete(graphs.keys().next().value!);
  return loading;
}

/** Test hook: empty the graph cache. */
export function clearGraphCache() {
  graphs.clear();
}

// ---------------------------------------------------------------- queries

export function manifestOf(a: OwnedAnalysis) {
  const i = summaryOf(a).intelligence;
  return i ? { manifest: i.manifest, totals: i.totals, symbolLanguages: i.symbolLanguages, truncated: i.truncated } : null;
}

/** Modules of the index merged with the architecture module metrics (both use the same directory depth). */
export function modulesOf(a: OwnedAnalysis) {
  const s = summaryOf(a);
  if (!s.intelligence) return null;
  const arch = new Map((s.architecture?.modules ?? []).map((m) => [m.key, m]));
  return s.intelligence.modules.map((m) => {
    const x = arch.get(m.key);
    return { ...m, fanIn: x?.fanIn ?? null, fanOut: x?.fanOut ?? null, instability: x?.instability ?? null, inCycle: x?.inCycle ?? false, layer: x?.layer ?? null };
  });
}

export async function listSymbols(analysisId: string, q: SymbolsQuery) {
  const where: Prisma.CodeSymbolWhereInput = {
    analysisId,
    ...(q.q ? { name: { contains: q.q, mode: "insensitive" } } : {}),
    ...(q.kind?.length ? { kind: { in: q.kind } } : {}),
    ...(q.path ? { file: { path: q.path } } : {}),
    ...(q.exported !== undefined ? { exported: q.exported } : {}),
  };
  const prisma = getPrisma();
  const [total, rows] = await Promise.all([
    prisma.codeSymbol.count({ where }),
    prisma.codeSymbol.findMany({
      where,
      orderBy: [{ exported: "desc" }, { name: "asc" }, { line: "asc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: {
        id: true,
        name: true,
        kind: true,
        parent: true,
        exported: true,
        isDefault: true,
        line: true,
        endLine: true,
        signature: true,
        file: { select: { path: true } },
        _count: { select: { callers: true } },
      },
    }),
  ]);
  return {
    symbols: rows.map(({ file, _count, ...s }) => ({ ...s, path: file.path, callers: _count.callers })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

export async function listReferences(analysisId: string, q: ReferencesQuery) {
  const where: Prisma.SymbolReferenceWhereInput = { analysisId, ...(q.symbolId ? { targetSymbolId: q.symbolId } : { name: q.name }) };
  const prisma = getPrisma();
  const [total, rows] = await Promise.all([
    prisma.symbolReference.count({ where }),
    prisma.symbolReference.findMany({
      where,
      orderBy: [{ file: { path: "asc" } }, { line: "asc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: {
        name: true,
        receiver: true,
        line: true,
        targetSymbolId: true,
        file: { select: { path: true } },
        fromSymbol: { select: { name: true, parent: true } },
      },
    }),
  ]);
  return {
    references: rows.map((r) => ({
      path: r.file.path,
      line: r.line,
      name: r.name,
      receiver: r.receiver,
      resolved: r.targetSymbolId !== null,
      caller: r.fromSymbol ? (r.fromSymbol.parent ? `${r.fromSymbol.parent}.${r.fromSymbol.name}` : r.fromSymbol.name) : null,
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

/** What a file imports (repository files, packages, standard library, unresolved), or which files import it. */
export async function fileImports(analysisId: string, q: ImportsQuery) {
  const prisma = getPrisma();
  const file = await prisma.file.findUnique({ where: { analysisId_path: { analysisId, path: q.path } }, select: { id: true, path: true, kind: true } });
  if (!file) return { file: null, imports: [], importers: [] };
  if (q.direction === "importers") {
    const rows = await prisma.fileDependency.findMany({
      where: { analysisId, toFileId: file.id },
      select: { specifier: true, fromFile: { select: { path: true, kind: true } } },
      orderBy: { fromFile: { path: "asc" } },
    });
    return { file, imports: [], importers: rows.map((r) => ({ path: r.fromFile.path, kind: r.fromFile.kind, specifier: r.specifier })) };
  }
  const rows = await prisma.fileDependency.findMany({
    where: { analysisId, fromFileId: file.id },
    select: { specifier: true, kind: true, packageName: true, toFile: { select: { path: true } } },
    orderBy: [{ kind: "asc" }, { specifier: "asc" }],
  });
  return {
    file,
    imports: rows.map((r) => ({ specifier: r.specifier, kind: r.kind, path: r.toFile?.path ?? null, packageName: r.packageName })),
    importers: [],
  };
}

/** Subgraph for drawing an impact result: the target and its direct dependants (the shape of /architecture's file view). */
function impactGraph(graph: RepositoryGraph, result: ImpactResult) {
  const keep = [...result.target.files, ...result.directDependents].slice(0, 60);
  const set = new Set(keep);
  const nodes = keep.map((path) => ({ key: `file:${path}`, kind: "FILE" as const, label: path, layer: null, metrics: { target: result.target.files.includes(path) } }));
  const edges = keep.flatMap((path) =>
    graph
      .imports(path)
      .filter((to) => set.has(to))
      .map((to) => ({ from: `file:${path}`, to: `file:${to}`, kind: "import", weight: 1, inCycle: false })),
  );
  return { view: "files" as const, nodes, edges, total: keep.length, truncated: result.target.files.length + result.directDependents.length > keep.length };
}

export async function impactOf(a: OwnedAnalysis, q: Pick<ImpactQuery, "type" | "target" | "path" | "depth">) {
  const graph = await graphFor(a);
  const target: ImpactTarget = q.type === "file" ? { type: "file", path: q.target } : q.type === "module" ? { type: "module", module: q.target } : { type: "symbol", name: q.target, path: q.path };
  const result = graph.impact(target, { depth: q.depth });
  return { ...result, graph: impactGraph(graph, result) };
}

/** Structured context for agents. Each operation maps onto the same deterministic queries as the REST endpoints. */
export async function answerContext(a: OwnedAnalysis, req: ContextRequest) {
  switch (req.operation) {
    case "manifest":
      return manifestOf(a);
    case "file_imports":
      return fileImports(a.id, { path: req.path, direction: "imports" });
    case "file_importers":
      return fileImports(a.id, { path: req.path, direction: "importers" });
    default:
      break;
  }
  const graph = await graphFor(a);
  switch (req.operation) {
    case "search":
      return { hits: graph.search(req.query, req.limit) };
    case "find_symbol":
      return { symbols: graph.findSymbols(req.name, req.path) };
    case "find_references": {
      const symbols = graph.findSymbols(req.name, req.path);
      return { symbols, callers: symbols.flatMap((s) => graph.callers(s.id).map((c) => ({ ...c, symbol: s.id }))) };
    }
    case "related_tests": {
      const f = graph.fileByPath(req.path);
      return { file: f?.path ?? null, tests: f ? graph.relatedTests([f.id]) : [] };
    }
    case "find_route":
      return { routes: graph.search(req.query, 50).filter((h) => h.type === "route") };
    case "impact_analysis": {
      const type = req.type ?? (graph.fileByPath(req.target) ? "file" : modulesOf(a)?.some((m) => m.key === req.target) ? "module" : "symbol");
      return impactOf(a, { type, target: req.target, path: req.path, depth: req.depth });
    }
  }
}
