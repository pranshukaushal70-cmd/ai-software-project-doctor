import { describe, expect, it } from "vitest";
import { LAYOUT, layoutGraph, shortenLabel } from "@/components/analysis/graph-layout";

const graph = (edges: Array<[string, string]>, extra: string[] = []) => {
  const keys = [...new Set([...edges.flat(), ...extra])];
  return layoutGraph({ nodes: keys.map((k) => ({ key: k, label: k })), edges: edges.map(([from, to]) => ({ from, to })) });
};
const cols = (l: ReturnType<typeof layoutGraph>) => Object.fromEntries([...l.nodes].map(([k, n]) => [k, n.col]));

describe("layoutGraph", () => {
  it("places importers left of what they import, by longest import chain", () => {
    expect(cols(graph([["a", "b"], ["b", "c"], ["a", "c"]]))).toEqual({ a: 0, b: 1, c: 2 });
    expect(cols(graph([["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]]))).toEqual({ a: 0, b: 1, c: 1, d: 2 });
  });

  it("keeps the files of one import cycle in one column", () => {
    const l = graph([["a", "b"], ["b", "a"], ["c", "a"], ["b", "d"]]);
    expect(cols(l)).toEqual({ a: 1, b: 1, c: 0, d: 2 });
    expect(l.nodes.get("a")!.row).not.toBe(l.nodes.get("b")!.row);
  });

  it("orders rows to avoid crossings", () => {
    // Alphabetical order would draw A→q and B→p as crossing lines.
    const l = graph([["A", "q"], ["B", "p"]]);
    expect(l.nodes.get("A")!.row).toBe(l.nodes.get("q")!.row);
    expect(l.nodes.get("B")!.row).toBe(l.nodes.get("p")!.row);
  });

  it("gives every node its own position and sizes the canvas to fit", () => {
    const l = graph([["a", "b"], ["a", "c"], ["a", "d"], ["e", "b"]], ["isolated"]);
    const positions = [...l.nodes.values()].map((n) => `${n.x},${n.y}`);
    expect(new Set(positions).size).toBe(l.nodes.size);
    for (const n of l.nodes.values()) {
      expect(n.x + LAYOUT.nodeWidth).toBeLessThanOrEqual(l.width);
      expect(n.y + LAYOUT.nodeHeight).toBeLessThanOrEqual(l.height);
    }
    expect(l.columns).toBe(2);
    expect(l.rows).toBe(3);
  });

  it("is deterministic and ignores self-loops and edges to unknown nodes", () => {
    const a = graph([["x", "y"], ["y", "y"], ["x", "ghost"]]);
    const b = graph([["x", "y"], ["y", "y"], ["x", "ghost"]]);
    expect([...a.nodes]).toEqual([...b.nodes]);
    const withUnknown = layoutGraph({ nodes: [{ key: "x", label: "x" }], edges: [{ from: "x", to: "nope" }] });
    expect(withUnknown.columns).toBe(1);
    expect(layoutGraph({ nodes: [], edges: [] })).toMatchObject({ columns: 0, rows: 0, width: 0, height: 0 });
  });
});

describe("shortenLabel", () => {
  it("keeps short labels and the end of long paths", () => {
    expect(shortenLabel("src/a.ts")).toBe("src/a.ts");
    const long = "packages/analyzer/src/architecture/resolve.ts";
    const short = shortenLabel(long);
    expect(short.startsWith("…")).toBe(true);
    expect(short.endsWith("architecture/resolve.ts")).toBe(true);
    expect(short.length).toBe(26);
  });
});
