/**
 * Layered left-to-right layout for small import graphs (tens to a few hundred
 * nodes). Importers are placed left of what they import: each node's column is
 * the length of the longest import chain reaching it. Nodes of one import cycle
 * share a column (a cycle has no order). Rows are ordered by the barycenter of
 * neighbouring rows to reduce edge crossings. Pure and deterministic.
 */

export interface LayoutInput {
  nodes: ReadonlyArray<{ key: string; label: string }>;
  edges: ReadonlyArray<{ from: string; to: string }>;
}

export interface LayoutNode {
  key: string;
  col: number;
  row: number;
  x: number;
  y: number;
}

export interface Layout {
  nodes: Map<string, LayoutNode>;
  columns: number;
  rows: number;
  width: number;
  height: number;
}

export const LAYOUT = { nodeWidth: 184, nodeHeight: 34, gapX: 72, gapY: 14, pad: 12 } as const;

/** Strongly connected components (Tarjan), as component index per node. */
function components(n: number, adj: number[][]): number[] {
  const index = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const comp = new Array<number>(n).fill(-1);
  const stack: number[] = [];
  let counter = 0;
  let count = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    const work: Array<[number, number]> = [[root, 0]];
    index[root] = low[root] = counter++;
    stack.push(root);
    onStack[root] = true;
    while (work.length) {
      const frame = work[work.length - 1]!;
      const [v, i] = frame;
      if (i < adj[v]!.length) {
        frame[1]++;
        const w = adj[v]![i]!;
        if (index[w] === -1) {
          index[w] = low[w] = counter++;
          stack.push(w);
          onStack[w] = true;
          work.push([w, 0]);
        } else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
        continue;
      }
      work.pop();
      if (work.length) {
        const p = work[work.length - 1]![0];
        low[p] = Math.min(low[p]!, low[v]!);
      }
      if (low[v] === index[v]) {
        let w: number;
        do {
          w = stack.pop()!;
          onStack[w] = false;
          comp[w] = count;
        } while (w !== v);
        count++;
      }
    }
  }
  return comp;
}

export function layoutGraph(input: LayoutInput): Layout {
  const nodes = [...input.nodes].sort((a, b) => a.label.localeCompare(b.label));
  const n = nodes.length;
  const idx = new Map(nodes.map((nd, i) => [nd.key, i]));
  const adj: number[][] = nodes.map(() => []);
  const radj: number[][] = nodes.map(() => []);
  for (const e of input.edges) {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    adj[a]!.push(b);
    radj[b]!.push(a);
  }

  // Columns: longest path over the condensation (a DAG), in topological order.
  const comp = components(n, adj);
  const compCount = comp.reduce((m, c) => Math.max(m, c + 1), 0);
  const cAdj = Array.from({ length: compCount }, () => new Set<number>());
  const indeg = new Array<number>(compCount).fill(0);
  for (let v = 0; v < n; v++) {
    for (const w of adj[v]!) {
      const a = comp[v]!;
      const b = comp[w]!;
      if (a !== b && !cAdj[a]!.has(b)) {
        cAdj[a]!.add(b);
        indeg[b]!++;
      }
    }
  }
  const level = new Array<number>(compCount).fill(0);
  const queue = [...indeg.keys()].filter((c) => indeg[c] === 0);
  for (let head = 0; head < queue.length; head++) {
    const c = queue[head]!;
    for (const d of cAdj[c]!) {
      level[d] = Math.max(level[d]!, level[c]! + 1);
      if (--indeg[d]! === 0) queue.push(d);
    }
  }
  const col = nodes.map((_, v) => level[comp[v]!]!);
  const columns = n ? Math.max(...col) + 1 : 0;

  // Rows: start alphabetically (nodes are sorted), then two barycenter sweeps.
  const byCol: number[][] = Array.from({ length: columns }, () => []);
  for (let v = 0; v < n; v++) byCol[col[v]!]!.push(v);
  const row = new Array<number>(n).fill(0);
  const assign = () => byCol.forEach((vs) => vs.forEach((v, r) => (row[v] = r)));
  assign();
  const sweep = (neighbours: number[][], order: number[]) => {
    for (const c of order) {
      const center = (v: number) => {
        const ns = neighbours[v]!.filter((u) => col[u] !== c);
        return ns.length ? ns.reduce((s, u) => s + row[u]!, 0) / ns.length : row[v]!;
      };
      const centers = new Map(byCol[c]!.map((v) => [v, center(v)]));
      byCol[c]!.sort((a, b) => centers.get(a)! - centers.get(b)! || a - b);
      byCol[c]!.forEach((v, r) => (row[v] = r));
    }
  };
  const cols = [...Array(columns).keys()];
  sweep(radj, cols.slice(1));
  sweep(adj, cols.slice(0, -1).reverse());

  const rows = byCol.reduce((m, vs) => Math.max(m, vs.length), 0);
  const { nodeWidth, nodeHeight, gapX, gapY, pad } = LAYOUT;
  const out = new Map<string, LayoutNode>();
  nodes.forEach((nd, v) =>
    out.set(nd.key, {
      key: nd.key,
      col: col[v]!,
      row: row[v]!,
      x: pad + col[v]! * (nodeWidth + gapX),
      y: pad + row[v]! * (nodeHeight + gapY),
    }),
  );
  return {
    nodes: out,
    columns,
    rows,
    width: columns ? pad * 2 + columns * nodeWidth + (columns - 1) * gapX : 0,
    height: rows ? pad * 2 + rows * nodeHeight + (rows - 1) * gapY : 0,
  };
}

/** Keep the end of long paths, which is the informative part (`…/core/orders.ts`). */
export function shortenLabel(label: string, max = 26): string {
  return label.length <= max ? label : `…${label.slice(label.length - max + 1)}`;
}
