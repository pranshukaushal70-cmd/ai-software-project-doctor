import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ArchitecturePanel, GraphView, ImportGraph } from "@/components/analysis/architecture-panel";
import type { ArchitectureGraphDto } from "@/components/analysis/types";
import { architectureSummary } from "./ui-fixtures";

const render = (summary = architectureSummary()) => renderToStaticMarkup(createElement(ArchitecturePanel, { analysisId: "a1", summary }));

const graph = (over: Partial<ArchitectureGraphDto> = {}): ArchitectureGraphDto => ({
  summary: null,
  view: "files",
  nodes: [
    { key: "file:src/core/a.ts", kind: "FILE", label: "src/core/a.ts", layer: null, metrics: { fanIn: 2, fanOut: 1, inCycle: true } },
    { key: "file:src/core/b.ts", kind: "FILE", label: "src/core/b.ts", layer: null, metrics: { fanIn: 2, fanOut: 1, inCycle: true } },
    { key: "file:src/api/handler.ts", kind: "FILE", label: "src/api/handler.ts", layer: "interface", metrics: { fanIn: 0, fanOut: 2, inCycle: false } },
  ],
  edges: [
    { from: "file:src/core/a.ts", to: "file:src/core/b.ts", kind: "import", weight: 1, inCycle: true },
    { from: "file:src/core/b.ts", to: "file:src/core/a.ts", kind: "import", weight: 1, inCycle: true },
    { from: "file:src/api/handler.ts", to: "file:src/core/a.ts", kind: "import", weight: 3, inCycle: false },
  ],
  total: 3,
  truncated: false,
  ...over,
});

describe("ArchitecturePanel", () => {
  it("shows cycles with their path, modules, hubs, layers and external packages", () => {
    const html = render();
    expect(html).toContain("Import cycles");
    expect(html).toContain('aria-label="Cycle path"');
    expect(html.match(/src\/core\/a\.ts/g)!.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Modules");
    expect(html).toContain("core");
    expect(html).toContain("Most imported files");
    expect(html).toContain("Fewer than two layers were recognised");
    expect(html).toContain("react");
    expect(html).toContain("Architecture findings");
    expect(html).toContain("1 local-looking imports matched no file");
  });

  it("starts with the graph in its loading state", () => {
    expect(render()).toContain('aria-label="Loading graph"');
  });

  it("omits the cycles card when there are none and explains an empty repository", () => {
    const clean = render(architectureSummary({ cycles: [], totals: { ...architectureSummary().totals, cycles: 0, filesInCycles: 0 } }));
    expect(clean).not.toContain("Import cycles</h3>");
    expect(clean).toContain("none found");
    expect(render(architectureSummary({ totals: { ...architectureSummary().totals, files: 0 } }))).toContain("No source files to map");
  });
});

describe("GraphView", () => {
  const view = (props: Parameters<typeof GraphView>[0]) => renderToStaticMarkup(createElement(GraphView, props));

  it("shows loading, error and empty states", () => {
    expect(view({ graph: null, error: null })).toContain("Loading graph");
    expect(view({ graph: null, error: "Analysis not found" })).toContain("Analysis not found");
    expect(view({ graph: graph({ nodes: [], edges: [], total: 0 }), error: null })).toContain("No files match this view");
    expect(view({ graph: graph({ view: "modules", edges: [] }), error: null })).toContain("The modules do not import each other");
  });

  it("draws the graph with a legend and notes truncation", () => {
    const html = view({ graph: graph({ total: 120, truncated: true }), error: null });
    expect(html).toContain("<svg");
    expect(html).toContain("part of an import cycle");
    expect(html).toContain("showing the 3 most connected of 120");
  });
});

describe("ImportGraph", () => {
  it("renders every node and edge, marking cycle edges and members", () => {
    const g = graph();
    const html = renderToStaticMarkup(createElement(ImportGraph, { nodes: g.nodes, edges: g.edges }));
    expect(html).toContain('aria-label="Import graph: 3 nodes, 3 dependencies.');
    expect(html.match(/<rect/g)).toHaveLength(3);
    // Edge paths (the two arrow-marker paths are not edges).
    expect(html.match(/<path d="M[^"]*" fill="none"/g)).toHaveLength(3);
    expect(html.match(/marker-end="url\(#arrow-cycle\)"/g)).toHaveLength(2);
    expect(html).toContain("src/api/handler.ts → src/core/a.ts (3 imports)");
    expect(html).toContain("part of an import cycle");
  });
});
