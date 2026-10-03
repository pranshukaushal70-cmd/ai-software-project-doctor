import { RepositoryGraph, type GraphRoute, type IntelligenceSummary } from "@pd/analyzer/intelligence";
import type { PrismaClient } from "@pd/db";

/**
 * Builds the in-memory query graph of an analysis from its stored index rows
 * (files, internal imports, symbols, call references, routes). Shared by the web
 * tier (which caches it per analysis) and the worker (planning and code-engine
 * jobs). Ids, paths and names only: no file contents.
 */

export interface StoredSummary {
  intelligence?: IntelligenceSummary;
  practices?: { api?: { list?: GraphRoute[] } };
  architecture?: { modules?: Array<{ key: string; fanIn: number; fanOut: number; instability: number; inCycle: boolean; layer: string | null }> };
}

export type GraphPrisma = Pick<PrismaClient, "file" | "fileDependency" | "codeSymbol" | "symbolReference">;

export async function loadRepositoryGraph(prisma: GraphPrisma, analysis: { id: string; summary: unknown }): Promise<RepositoryGraph> {
  const analysisId = analysis.id;
  const [files, edges, symbols, references] = await Promise.all([
    prisma.file.findMany({ where: { analysisId }, select: { id: true, path: true, kind: true } }),
    prisma.fileDependency.findMany({ where: { analysisId, kind: "INTERNAL" }, select: { fromFileId: true, toFileId: true } }),
    prisma.codeSymbol.findMany({
      where: { analysisId },
      select: { id: true, fileId: true, name: true, kind: true, parent: true, exported: true, line: true, endLine: true, signature: true },
    }),
    prisma.symbolReference.findMany({ where: { analysisId }, select: { fileId: true, fromSymbolId: true, targetSymbolId: true, name: true, receiver: true, line: true } }),
  ]);
  const summary = (analysis.summary ?? {}) as StoredSummary;
  return new RepositoryGraph({
    files,
    edges: edges.filter((e) => e.toFileId).map((e) => ({ from: e.fromFileId, to: e.toFileId! })),
    symbols,
    references,
    routes: summary.practices?.api?.list ?? [],
    moduleDepth: summary.intelligence?.moduleDepth ?? 1,
  });
}
