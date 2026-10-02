import "server-only";
import type { ArchitectureSummary } from "@pd/analyzer/architecture";
import { getPrisma } from "@pd/db";
import type { ArchitectureQuery } from "@pd/shared";

/**
 * The architecture summary stored on Analysis.summary by the worker, or null
 * when the analysis has not finished or predates the architecture analyzer.
 */
export function architectureSummaryOf(summary: unknown): ArchitectureSummary | null {
  if (!summary || typeof summary !== "object") return null;
  const arch = (summary as { architecture?: unknown }).architecture;
  return arch && typeof arch === "object" && (arch as { analyzer?: unknown }).analyzer === "architecture" ? (arch as ArchitectureSummary) : null;
}

export interface NodeRow {
  id: string;
  key: string;
  label: string;
  layer: string | null;
  metrics: unknown;
}

export interface EdgeRow {
  fromId: string;
  toId: string;
  kind: string;
  weight: number;
  inCycle: boolean;
}

const metricsOf = (n: NodeRow) => (n.metrics && typeof n.metrics === "object" ? (n.metrics as Record<string, unknown>) : {});
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const degree = (n: NodeRow) => num(metricsOf(n).fanIn) + num(metricsOf(n).fanOut);

/**
 * Apply the module/cycle filters and keep the `limit` most connected nodes
 * (ties by label, so the result is stable).
 */
export function selectNodes(nodes: readonly NodeRow[], q: Pick<ArchitectureQuery, "view" | "module" | "cycles" | "limit">) {
  const matching = nodes.filter((n) => {
    const m = metricsOf(n);
    if (q.view === "files" && q.module !== undefined && m.module !== q.module) return false;
    if (q.cycles !== undefined && (m.inCycle === true) !== q.cycles) return false;
    return true;
  });
  const kept = [...matching].sort((a, b) => degree(b) - degree(a) || a.label.localeCompare(b.label)).slice(0, q.limit);
  return { nodes: kept, total: matching.length, truncated: matching.length > kept.length };
}

/** Edges between selected nodes, addressed by node key (database ids are an implementation detail). */
export function toGraphEdges(edges: readonly EdgeRow[], keyById: ReadonlyMap<string, string>) {
  const out: Array<{ from: string; to: string; kind: string; weight: number; inCycle: boolean }> = [];
  for (const e of edges) {
    const from = keyById.get(e.fromId);
    const to = keyById.get(e.toId);
    if (from && to) out.push({ from, to, kind: e.kind, weight: e.weight, inCycle: e.inCycle });
  }
  return out.sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/** The module graph, or the file import graph (optionally one module or only cycles), bounded by `limit`. */
export async function getArchitectureGraph(analysisId: string, q: ArchitectureQuery, summary: ArchitectureSummary | null) {
  const prisma = getPrisma();
  const kind = q.view === "modules" ? "MODULE" : "FILE";
  const all = await prisma.architectureNode.findMany({
    where: { analysisId, kind },
    select: { id: true, key: true, label: true, layer: true, metrics: true },
  });
  const selected = selectNodes(all, q);
  const ids = selected.nodes.map((n) => n.id);
  const edges =
    ids.length === 0
      ? []
      : await prisma.architectureEdge.findMany({
          where: { analysisId, kind: q.view === "modules" ? "module" : "import", fromId: { in: ids }, toId: { in: ids } },
          select: { fromId: true, toId: true, kind: true, weight: true, inCycle: true },
        });
  return {
    summary,
    view: q.view,
    nodes: selected.nodes.map(({ key, label, layer, metrics }) => ({ key, kind, label, layer, metrics })),
    edges: toGraphEdges(edges, new Map(selected.nodes.map((n) => [n.id, n.key]))),
    total: selected.total,
    truncated: selected.truncated,
  };
}
