import { expect, test } from "@playwright/test";
import { demoAnalysis, users } from "../../lib/flows";

// Phase 6: the repository index of the demo analysis, through every intelligence endpoint.

interface Symbol {
  id: string;
  name: string;
  kind: string;
  path: string;
}

test("manifest and modules describe the demo repository", async () => {
  const { owner } = users();
  const id = (await demoAnalysis(owner)).id;
  const manifest = await owner.get<{ manifest: Record<string, unknown> }>(`/api/analysis/${id}/manifest`);
  expect(manifest.status).toBe(200);
  expect(JSON.stringify(manifest.data.manifest)).toContain('"primaryLanguage":"javascript"');
  // Secret files are listed by path only, never with contents.
  expect(manifest.text).not.toContain("Sup3r-Secret-Admin-Pw");
  const modules = await owner.get(`/api/analysis/${id}/modules`);
  expect(modules.status).toBe(200);
  expect(modules.text).toContain("src");
});

test("symbols, references and imports resolve across files", async () => {
  const { owner } = users();
  const id = (await demoAnalysis(owner)).id;
  const symbols = await owner.get<{ symbols: Symbol[] }>(`/api/analysis/${id}/symbols?q=createOrder`);
  expect(symbols.status).toBe(200);
  const createOrder = symbols.data.symbols.find((s) => s.name === "createOrder");
  expect(createOrder?.path).toBe("src/orders.js");

  const refs = await owner.get<{ references: { path: string; resolved: boolean }[] }>(`/api/analysis/${id}/references?name=createOrder`);
  expect(refs.status).toBe(200);
  expect(refs.data.references).toContainEqual(expect.objectContaining({ path: "src/server.js", resolved: true }));

  const importers = await owner.get<{ importers: { path: string }[] }>(`/api/analysis/${id}/imports?path=src/orders.js&direction=importers`);
  expect(importers.status).toBe(200);
  expect(importers.data.importers.map((i) => i.path)).toContain("src/server.js");
});

test("impact analysis and the agent context interface answer for a file", async () => {
  const { owner } = users();
  const id = (await demoAnalysis(owner)).id;
  const impact = await owner.get<{ impact: { directDependents: string[]; graph: { nodes: unknown[] } } }>(`/api/analysis/${id}/impact?type=file&target=src/pricing.js`);
  expect(impact.status).toBe(200);
  expect(impact.data.impact.graph.nodes.length).toBeGreaterThan(0);
  expect(impact.data.impact.directDependents).toContain("src/orders.js");

  const context = await owner.post<{ indexed: boolean; operation: string; result: { symbols: { name: string; path: string }[] } }>(`/api/analysis/${id}/context`, { operation: "find_symbol", name: "discountFor" });
  expect(context.status).toBe(200);
  expect(context.data).toMatchObject({ indexed: true, operation: "find_symbol" });
  expect(context.data.result.symbols).toContainEqual(expect.objectContaining({ name: "discountFor", path: "src/pricing.js" }));
});

test("repository paths are validated", async () => {
  const { owner, intruder } = users();
  const id = (await demoAnalysis(owner)).id;
  for (const bad of ["../etc/passwd", "/etc/passwd", "src\\server.js"]) {
    expect((await owner.get(`/api/analysis/${id}/imports?path=${encodeURIComponent(bad)}&direction=imports`)).status, bad).toBe(400);
  }
  expect((await intruder.post(`/api/analysis/${id}/context`, { operation: "manifest" })).status).toBe(404);
});
