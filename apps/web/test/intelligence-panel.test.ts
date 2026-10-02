import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanRepository } from "@pd/analyzer";
import { buildRepositoryIndex, createSymbolCollector } from "@pd/analyzer/intelligence";
import { analyzeCode } from "@pd/analyzer/metrics";
import { CompletedAnalysis, type AnalysisDto } from "@/components/analysis/analysis-view";
import { ImpactResultView, IntelligencePanel, ManifestCard } from "@/components/analysis/intelligence-panel";
import type { CodeMetricsDto, ImpactDto, IntelligenceSummaryDto } from "@/components/analysis/types";
import { scanSummary } from "./ui-fixtures";

/** A real summary from the analyzer, so the UI is tested against the shape it actually receives. */
let summary: IntelligenceSummaryDto;
let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "pd-intel-ui-"));
  const files = {
    "package.json": JSON.stringify({ name: "shop-api", engines: { node: ">=22" } }),
    Dockerfile: "FROM node:22-alpine\n",
    ".env": "SECRET=never-shown\n",
    "src/db.ts": "export const query = (sql: string) => sql;\n",
    "src/users.ts": 'import { query } from "./db";\nexport function createUser() { return query("insert"); }\n',
    "src/users.test.ts": 'import { createUser } from "./users";\nit("x", () => createUser());\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  const scan = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
  const collector = createSymbolCollector();
  const code = await analyzeCode(scan.files, { onTree: collector.inspectTree });
  summary = (await buildRepositoryIndex(scan, code, collector.files(), { name: "shop", moduleDepth: 1 })).summary as unknown as IntelligenceSummaryDto;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("IntelligencePanel", () => {
  it("shows index totals, the manifest, modules, most depended-upon files and the tools", () => {
    const html = renderToStaticMarkup(createElement(IntelligencePanel, { analysisId: "a1", summary }));
    expect(html).toContain("Files indexed");
    expect(html).toContain("Repository manifest");
    expect(html).toContain("Node.js &gt;=22");
    expect(html).toContain("Node.js 22-alpine");
    expect(html).toContain("src/db.ts");
    expect(html).toContain("Impact analysis");
    expect(html).toContain("Symbols");
    expect(html).toContain("Repository tree");
    expect(html).toContain("Everything on this tab is deterministic");
  });

  it("names secret files without ever showing their contents", () => {
    const html = renderToStaticMarkup(createElement(ManifestCard, { summary }));
    expect(html).toContain("1 secret file was found by name (.env) and excluded");
    expect(html).not.toContain("never-shown");
  });

  it("is a tab of the analysis page, with a notice for analyses made before indexing", () => {
    const analysis = (s: typeof summary | undefined, version: string): AnalysisDto => ({
      id: "a1",
      status: "COMPLETED",
      stage: "COMPLETED",
      progress: 100,
      mode: "LOCAL_ONLY",
      analyzerVersion: version,
      commitSha: null,
      error: null,
      summary: scanSummary({ codeMetrics: { findings: { stored: 0 } } as unknown as CodeMetricsDto, intelligence: s }),
      createdAt: "2026-10-04T00:00:00Z",
      startedAt: null,
      finishedAt: null,
      repository: { id: "r1", name: "shop", owner: null, url: null, source: "ZIP", branch: null },
    });
    const now = renderToStaticMarkup(createElement(CompletedAnalysis, { analysis: analysis(summary, "0.6.0"), initialTab: "intelligence" }));
    expect(now).toContain('id="tab-intelligence"');
    expect(now).toContain("Repository manifest");
    const old = renderToStaticMarkup(createElement(CompletedAnalysis, { analysis: analysis(undefined, "0.5.0"), initialTab: "intelligence" }));
    expect(old).toContain("produced by analyzer v0.5.0, before the repository index existed");
  });
});

describe("ImpactResultView", () => {
  const impact = (over: Partial<ImpactDto> = {}): ImpactDto => ({
    target: { type: "file", value: "src/db.ts", files: ["src/db.ts"], symbols: [], found: true },
    dependencies: [],
    directDependents: ["src/users.ts"],
    transitiveDependents: [
      { path: "src/users.ts", depth: 1 },
      { path: "src/users.test.ts", depth: 2 },
    ],
    callers: [],
    relatedTests: [{ path: "src/users.test.ts", reason: "imports", depth: 2 }],
    relatedRoutes: [{ method: "POST", path: "/users", file: "src/users.ts", line: 3, framework: "Express" }],
    relatedConfig: [{ path: "package.json", reason: "nearest package manifest" }],
    affectedModules: [{ module: "src", files: 3 }],
    truncated: false,
    graph: {
      view: "files",
      nodes: [
        { key: "file:src/db.ts", kind: "FILE", label: "src/db.ts", layer: null, metrics: null },
        { key: "file:src/users.ts", kind: "FILE", label: "src/users.ts", layer: null, metrics: null },
      ],
      edges: [{ from: "file:src/users.ts", to: "file:src/db.ts", kind: "import", weight: 1, inCycle: false }],
      total: 2,
      truncated: false,
    },
    ...over,
  });

  it("summarises what a change affects and draws the dependants", () => {
    const html = renderToStaticMarkup(createElement(ImpactResultView, { impact: impact() }));
    expect(html).toContain("can affect <strong>2</strong> files in 1 module, <strong>1</strong> test and <strong>1</strong> API route");
    expect(html).toContain("<svg");
    expect(html).toContain("imports it (distance 2)");
    expect(html).toContain("POST /users");
    expect(html).toContain("nearest package manifest");
    expect(html).not.toContain("Call sites");
  });

  it("lists call sites for a symbol, marking name-only matches", () => {
    const html = renderToStaticMarkup(
      createElement(ImpactResultView, {
        impact: impact({
          target: { type: "symbol", value: "query", files: ["src/db.ts"], symbols: [], found: true },
          callers: [
            { path: "src/users.ts", line: 2, caller: "createUser", resolved: true },
            { path: "src/other.ts", line: 9, caller: null, resolved: false },
          ],
        }),
      }),
    );
    expect(html).toContain("Call sites");
    expect(html).toContain("src/users.ts:2");
    expect(html).toContain("same name, unresolved");
  });

  it("says when the target is not in the index instead of showing empty lists", () => {
    const html = renderToStaticMarkup(createElement(ImpactResultView, { impact: impact({ target: { type: "file", value: "nope.ts", files: [], symbols: [], found: false } }) }));
    expect(html).toContain("Nothing in the index matches “nope.ts”");
    expect(html).not.toContain("Directly affected");
  });
});
