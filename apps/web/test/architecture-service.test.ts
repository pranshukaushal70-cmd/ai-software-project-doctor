import { describe, expect, it } from "vitest";
import { architectureQuerySchema } from "@pd/shared";
import { architectureSummaryOf, selectNodes, toGraphEdges, type NodeRow } from "@/server/services/architecture-service";

const node = (id: string, label: string, metrics: Record<string, unknown>): NodeRow => ({ id, key: `file:${label}`, label, layer: null, metrics });
const query = (params: Record<string, string> = {}) => architectureQuerySchema.parse(params);

const NODES = [
  node("n1", "src/a.ts", { fanIn: 1, fanOut: 1, module: "src", inCycle: true }),
  node("n2", "src/b.ts", { fanIn: 3, fanOut: 2, module: "src", inCycle: true }),
  node("n3", "lib/c.ts", { fanIn: 0, fanOut: 0, module: "lib", inCycle: false }),
  node("n4", "lib/d.ts", { fanIn: 1, fanOut: 1, module: "lib", inCycle: false }),
];

describe("selectNodes", () => {
  it("orders by connectivity, then label, and reports truncation", () => {
    const res = selectNodes(NODES, query({ view: "files", limit: "3" }));
    expect(res.nodes.map((n) => n.label)).toEqual(["src/b.ts", "lib/d.ts", "src/a.ts"]);
    expect(res).toMatchObject({ total: 4, truncated: true });
  });

  it("filters files by module and by cycle membership", () => {
    expect(selectNodes(NODES, query({ view: "files", module: "lib" })).nodes.map((n) => n.label)).toEqual(["lib/d.ts", "lib/c.ts"]);
    expect(selectNodes(NODES, query({ view: "files", cycles: "true" })).nodes.map((n) => n.label)).toEqual(["src/b.ts", "src/a.ts"]);
    expect(selectNodes(NODES, query({ view: "files", cycles: "false" })).total).toBe(2);
  });

  it("ignores the module filter in the module view and tolerates malformed metrics", () => {
    expect(selectNodes(NODES, query({ module: "lib" })).total).toBe(4);
    const odd = [{ ...NODES[0]!, metrics: null }, { ...NODES[1]!, metrics: { fanIn: "x" } }];
    expect(selectNodes(odd, query()).nodes).toHaveLength(2);
  });
});

describe("toGraphEdges", () => {
  it("addresses edges by node key, heaviest first, and drops edges to unselected nodes", () => {
    const keys = new Map([
      ["n1", "file:src/a.ts"],
      ["n2", "file:src/b.ts"],
    ]);
    const edges = toGraphEdges(
      [
        { fromId: "n1", toId: "n2", kind: "import", weight: 1, inCycle: true },
        { fromId: "n2", toId: "n1", kind: "import", weight: 3, inCycle: true },
        { fromId: "n2", toId: "n9", kind: "import", weight: 5, inCycle: false },
      ],
      keys,
    );
    expect(edges).toEqual([
      { from: "file:src/b.ts", to: "file:src/a.ts", kind: "import", weight: 3, inCycle: true },
      { from: "file:src/a.ts", to: "file:src/b.ts", kind: "import", weight: 1, inCycle: true },
    ]);
  });
});

describe("architectureQuerySchema", () => {
  it("applies defaults and bounds the limit", () => {
    expect(query()).toEqual({ view: "modules", limit: 300 });
    expect(() => query({ limit: "5000" })).toThrow();
    expect(() => query({ view: "layers" })).toThrow();
    expect(() => query({ cycles: "1" })).toThrow();
  });
});

describe("architectureSummaryOf", () => {
  it("returns the architecture summary only when the analyzer produced one", () => {
    const arch = { analyzer: "architecture" };
    expect(architectureSummaryOf({ architecture: arch })).toBe(arch);
    expect(architectureSummaryOf({ architecture: { analyzer: "x" } })).toBeNull();
    expect(architectureSummaryOf(undefined)).toBeNull();
  });
});
