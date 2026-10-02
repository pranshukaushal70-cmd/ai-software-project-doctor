import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeArchitecture,
  ARCHITECTURE_THRESHOLDS,
  createResolver,
  inferLayer,
  shortestCycle,
  stronglyConnectedComponents,
  stripJsonc,
  type ArchitectureAnalysis,
  type ArchitectureInputFile,
} from "../src/architecture";
import { analyzeCode } from "../src/metrics";
import { scanRepository, type ScannedFile } from "../src/scanner";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "polyglot");

const LANGUAGE: Record<string, string> = { ts: "typescript", tsx: "typescript", js: "javascript", py: "python", java: "java", c: "c", h: "c", cpp: "cpp" };
const languageOf = (p: string) => LANGUAGE[p.slice(p.lastIndexOf(".") + 1)] ?? "unknown";

/**
 * Architecture analysis over an in-memory import map (no files on disk, so no
 * tsconfig/package.json resolution). Paths under tests/ are TEST files.
 */
function analyzeGraph(imports: Record<string, string[]>, opts?: Parameters<typeof analyzeArchitecture>[3]) {
  const paths = Object.keys(imports);
  const kind = (p: string): ScannedFile["kind"] => (p.startsWith("tests/") ? "TEST" : "SOURCE");
  const scanFiles = paths.map((p) => ({ path: p, absPath: path.join(os.tmpdir(), "pd-arch-missing", p), size: 100, kind: kind(p) }));
  const codeFiles: ArchitectureInputFile[] = paths.map((p) => ({ path: p, language: languageOf(p), imports: imports[p]!, codeLines: 10 }));
  return analyzeArchitecture(scanFiles, codeFiles, new Map(paths.map((p) => [p, kind(p)])), opts);
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

/** Full pipeline on real files: scan → code metrics (imports) → architecture. */
async function analyzeDir(root: string) {
  const scan = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
  const code = await analyzeCode(scan.files);
  return analyzeArchitecture(
    scan.files,
    code.files.map((f) => ({ path: f.path, language: f.language, imports: f.metrics.imports, codeLines: f.metrics.codeLines })),
    new Map(scan.files.map((f) => [f.path, f.kind])),
  );
}

async function analyzeFiles(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pd-arch-test-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return analyzeDir(root);
}

const fileEdges = (res: ArchitectureAnalysis) =>
  res.edges
    .filter((e) => e.kind === "import")
    .map((e) => `${e.from.slice(5)} -> ${e.to.slice(5)}`)
    .sort();

const ring = (n: number, dir = "src/ring") =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${dir}/m${i}.ts`, [`./m${(i + 1) % n}`]]));

// ------------------------------------------------------------------ graph algorithms

describe("graph algorithms", () => {
  it("finds strongly connected components", () => {
    const comps = stronglyConnectedComponents([[1], [2], [0, 3], [4], [3], []]).map((c) => [...c].sort());
    expect(comps.filter((c) => c.length > 1).sort()).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
    expect(comps.flat().sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("handles very deep graphs without recursion", () => {
    const n = 200_000;
    const chain = Array.from({ length: n }, (_, i) => (i + 1 < n ? [i + 1] : [0]));
    const comps = stronglyConnectedComponents(chain);
    expect(comps).toHaveLength(1);
    expect(comps[0]).toHaveLength(n);
  });

  it("finds a shortest cycle inside a component", () => {
    const adj = [[1, 3], [2], [0], [0]];
    expect(shortestCycle(adj, 0, new Set([0, 1, 2, 3]))).toEqual([0, 3, 0]);
    expect(shortestCycle(adj, 0, new Set([0, 1, 2]))).toEqual([0, 1, 2, 0]);
    expect(shortestCycle([[1], []], 0, new Set([0, 1]))).toBeNull();
    expect(shortestCycle([[0]], 0, new Set([0]))).toEqual([0, 0]);
  });
});

// ------------------------------------------------------------------ layers / JSONC

describe("layer inference", () => {
  it.each([
    ["src/components/Button.tsx", "interface"],
    ["app/routes/users.ts", "interface"],
    ["src/main/java/com/demo/OrderController.java", "interface"],
    ["src/orders.service.ts", "service"],
    ["app/models/user.py", "data"],
    ["pkg/user_repository.py", "data"],
    ["src/utils/format.ts", "shared"],
    ["src/main.ts", null],
  ])("%s → %s", (p, layer) => {
    expect(inferLayer(p)).toBe(layer);
  });
});

describe("stripJsonc", () => {
  it("removes comments and trailing commas but keeps strings intact", () => {
    const text = '{\n  // comment\n  "url": "http://x//y", /* block */\n  "glob": "src/**/*.ts",\n  "list": [1, 2,],\n}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ url: "http://x//y", glob: "src/**/*.ts", list: [1, 2] });
  });
});

// ------------------------------------------------------------------ resolver

describe("import resolver", () => {
  const files: Record<string, string> = {
    "tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
    "tsconfig.json": '{ "extends": "./tsconfig.base", "compilerOptions": { "paths": { "@/*": ["./src/*"] } }, }',
    "src/a.ts": "",
    "src/b.ts": "",
    "src/dir/index.ts": "",
    "src/data.json": "",
    "lib/util/x.ts": "",
    "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", exports: { ".": { types: "./dist/index.d.ts", import: "./src/index.ts" }, "./*": "./src/*.ts" } }),
    "packages/ui/src/index.ts": "",
    "packages/ui/src/button.ts": "",
    "src/shop/__init__.py": "",
    "src/shop/models.py": "",
    "src/shop/api/__init__.py": "",
    "src/shop/api/views.py": "",
    "java/src/main/java/com/demo/Order.java": "",
    "java/src/main/java/com/demo/model/Item.java": "",
    "java/src/main/java/com/demo/model/Price.java": "",
    "native/buffer.c": "",
    "native/buffer.h": "",
    "include/lib/api.h": "",
  };
  const resolver = () => createResolver({ paths: Object.keys(files), read: async (p) => files[p] ?? null });

  it("resolves JavaScript/TypeScript relative imports, ESM .js specifiers, index files and aliases", async () => {
    const r = await resolver();
    const js = (spec: string) => r.resolve("src/a.ts", "typescript", spec);
    expect(js("./b")).toEqual({ kind: "internal", targets: ["src/b.ts"] });
    expect(js("./b.js")).toEqual({ kind: "internal", targets: ["src/b.ts"] });
    expect(js("./dir")).toEqual({ kind: "internal", targets: ["src/dir/index.ts"] });
    expect(js("@/dir")).toEqual({ kind: "internal", targets: ["src/dir/index.ts"] });
    expect(js("lib/util/x")).toEqual({ kind: "internal", targets: ["lib/util/x.ts"] });
    expect(js("@/missing")).toEqual({ kind: "unresolved" });
    expect(js("./missing")).toEqual({ kind: "unresolved" });
    expect(js("../../outside")).toEqual({ kind: "unresolved" });
    // tsconfig.base.json is only read through `extends`, so one project config is counted.
    expect(r.info).toMatchObject({ tsconfigs: 1, pathAliases: 1, workspacePackages: 1 });
  });

  it("resolves workspace packages through package.json exports", async () => {
    const r = await resolver();
    expect(r.resolve("src/a.ts", "typescript", "@acme/ui")).toEqual({ kind: "internal", targets: ["packages/ui/src/index.ts"] });
    expect(r.resolve("src/a.ts", "typescript", "@acme/ui/button")).toEqual({ kind: "internal", targets: ["packages/ui/src/button.ts"] });
  });

  it("classifies builtin and external JavaScript modules", async () => {
    const r = await resolver();
    expect(r.resolve("src/a.ts", "typescript", "node:fs")).toEqual({ kind: "builtin" });
    expect(r.resolve("src/a.ts", "javascript", "fs/promises")).toEqual({ kind: "builtin" });
    expect(r.resolve("src/a.ts", "typescript", "react")).toEqual({ kind: "external", name: "react" });
    expect(r.resolve("src/a.ts", "typescript", "@scope/pkg/sub")).toEqual({ kind: "external", name: "@scope/pkg" });
  });

  it("resolves Python relative and absolute imports from package roots", async () => {
    const r = await resolver();
    const py = (spec: string) => r.resolve("src/shop/api/views.py", "python", spec);
    expect(py("..models")).toEqual({ kind: "internal", targets: ["src/shop/models.py"] });
    expect(py("shop.models")).toEqual({ kind: "internal", targets: ["src/shop/models.py"] });
    expect(py("shop.models.User")).toEqual({ kind: "internal", targets: ["src/shop/models.py"] });
    expect(py("shop")).toEqual({ kind: "internal", targets: ["src/shop/__init__.py"] });
    expect(py("os.path")).toEqual({ kind: "builtin" });
    expect(py("requests")).toEqual({ kind: "external", name: "requests" });
    expect(py(".missing")).toEqual({ kind: "unresolved" });
    expect(r.info.pythonRoots).toEqual(["src"]);
  });

  it("resolves Java classes, nested classes and wildcard imports", async () => {
    const r = await resolver();
    const java = (spec: string) => r.resolve("java/src/main/java/com/demo/Order.java", "java", spec);
    expect(java("com.demo.model.*")).toEqual({
      kind: "internal",
      targets: ["java/src/main/java/com/demo/model/Item.java", "java/src/main/java/com/demo/model/Price.java"],
    });
    expect(java("com.demo.Order.Status")).toEqual({ kind: "internal", targets: ["java/src/main/java/com/demo/Order.java"] });
    expect(java("java.util.List")).toEqual({ kind: "builtin" });
    expect(java("org.springframework.web.Bind")).toEqual({ kind: "external", name: "org.springframework" });
  });

  it("resolves C/C++ includes next to the file, from include directories and system headers", async () => {
    const r = await resolver();
    const c = (spec: string) => r.resolve("native/buffer.c", "c", spec);
    expect(c("buffer.h")).toEqual({ kind: "internal", targets: ["native/buffer.h"] });
    expect(c("lib/api.h")).toEqual({ kind: "internal", targets: ["include/lib/api.h"] });
    expect(c("stdio.h")).toEqual({ kind: "builtin" });
    expect(c("vector")).toEqual({ kind: "builtin" });
    expect(c("openssl/ssl.h")).toEqual({ kind: "external", name: "openssl" });
  });
});

// ------------------------------------------------------------------ analyzeArchitecture (import maps)

describe("analyzeArchitecture", () => {
  it("detects an import cycle with its shortest path and marks cycle edges", async () => {
    const res = await analyzeGraph({
      "src/a.ts": ["./b"],
      "src/b.ts": ["./c"],
      "src/c.ts": ["./a"],
      "src/d.ts": ["./a", "react", "node:path", "./nope"],
    });
    const cycles = res.findings.filter((f) => f.type === "circular-dependency");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ severity: "MEDIUM", path: "src/a.ts", category: "ARCHITECTURE", ruleId: "architecture/circular-dependency", line: null });
    expect(cycles[0]!.evidence).toBe("`src/a.ts` → `src/b.ts` → `src/c.ts` → `src/a.ts`.");
    expect(res.summary.totals).toMatchObject({ files: 4, edges: 4, cycles: 1, filesInCycles: 3, externalImports: 1, builtinImports: 1, unresolvedImports: 1 });
    expect(res.summary.cycles[0]).toMatchObject({ size: 3, path: ["src/a.ts", "src/b.ts", "src/c.ts", "src/a.ts"] });
    const inCycle = res.edges.filter((e) => e.kind === "import" && e.inCycle).map((e) => `${e.from}>${e.to}`);
    expect(inCycle.sort()).toEqual(["file:src/a.ts>file:src/b.ts", "file:src/b.ts>file:src/c.ts", "file:src/c.ts>file:src/a.ts"]);
    expect(res.summary.topExternal).toEqual([{ name: "react", language: "typescript", files: 1 }]);
  });

  it("rates cycles in compiled languages lower and large cycles higher", async () => {
    const java = await analyzeGraph({
      "src/main/java/com/demo/A.java": ["com.demo.B"],
      "src/main/java/com/demo/B.java": ["com.demo.A"],
    });
    const f = java.findings.find((x) => x.type === "circular-dependency")!;
    expect(f.severity).toBe("LOW");
    expect(f.evidence).toContain("Compiled languages tolerate import cycles");

    const large = await analyzeGraph(ring(ARCHITECTURE_THRESHOLDS.largeCycleFiles));
    const big = large.findings.find((x) => x.type === "circular-dependency")!;
    expect(big.severity).toBe("HIGH");
    expect(big.data).toMatchObject({ size: 10 });
  });

  it("leaves test files out of the production graph", async () => {
    const res = await analyzeGraph({
      "src/a.ts": [],
      "tests/a.test.ts": ["../src/a"],
    });
    expect(res.summary.totals).toMatchObject({ files: 1, edges: 0, isolatedFiles: 1 });
    expect(res.nodes.filter((n) => n.kind === "FILE").map((n) => n.label)).toEqual(["src/a.ts"]);
  });

  it("reports imports from a lower layer into a higher one", async () => {
    const res = await analyzeGraph({
      "src/controllers/orders.ts": ["../services/orders"],
      "src/services/orders.ts": ["../models/order", "../utils/format"],
      "src/models/order.ts": [],
      "src/utils/format.ts": ["../services/orders"],
    });
    const violations = res.findings.filter((f) => f.type === "layer-violation");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ path: "src/utils/format.ts", severity: "LOW", data: { fromLayer: "shared", toLayer: "service", target: "src/services/orders.ts" } });
    expect(res.summary.layers).toMatchObject({ applied: true, violations: 1 });
    expect(res.summary.layers.order.map((l) => [l.id, l.files])).toEqual([
      ["interface", 1],
      ["service", 1],
      ["data", 1],
      ["shared", 1],
    ]);
  });

  it("skips layer checks when fewer than two layers are present", async () => {
    const res = await analyzeGraph({ "src/utils/a.ts": ["./b"], "src/utils/b.ts": [], "src/main.ts": ["./utils/a"] });
    expect(res.summary.layers.applied).toBe(false);
    expect(res.findings.filter((f) => f.type === "layer-violation")).toEqual([]);
  });

  it("flags high fan-out but not barrel files", async () => {
    const leaves = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`src/leaf/l${i}.ts`, [] as string[]]));
    const specs = (n: number) => Array.from({ length: n }, (_, i) => `./leaf/l${i}`);
    const res = await analyzeGraph({
      ...leaves(45),
      "src/medium.ts": specs(41),
      "src/low.ts": specs(21),
      "src/ok.ts": specs(20),
      "src/index.ts": specs(45),
    });
    const fanOut = res.findings.filter((f) => f.type === "high-fan-out").map((f) => [f.path, f.severity]);
    expect(fanOut.sort()).toEqual([
      ["src/low.ts", "LOW"],
      ["src/medium.ts", "MEDIUM"],
    ]);
    expect(res.summary.totals.maxFanOut).toBe(45);
    expect(res.summary.mostDependent[0]).toEqual({ path: "src/index.ts", fanIn: 0, fanOut: 45 });
  });

  it("aggregates a module view with fan-in, fan-out and instability", async () => {
    const res = await analyzeGraph({
      "src/api/a.ts": ["../db/x"],
      "src/api/b.ts": ["../db/x"],
      "src/db/x.ts": ["../shared/u"],
      "src/shared/u.ts": [],
    });
    expect(res.summary.moduleDepth).toBe(2);
    const mod = (key: string) => res.summary.modules.find((m) => m.key === key)!;
    expect(mod("src/api")).toMatchObject({ label: "api", files: 2, loc: 20, fanIn: 0, fanOut: 1, instability: 1, inCycle: false });
    expect(mod("src/db")).toMatchObject({ label: "db", fanIn: 1, fanOut: 1, instability: 0.5, layer: "data" });
    expect(mod("src/shared")).toMatchObject({ fanIn: 1, fanOut: 0, instability: 0 });
    expect(res.summary.moduleEdges).toEqual([
      { from: "src/api", to: "src/db", weight: 2, inCycle: false },
      { from: "src/db", to: "src/shared", weight: 1, inCycle: false },
    ]);
    expect(res.summary.hubs[0]).toEqual({ path: "src/db/x.ts", fanIn: 2, fanOut: 1 });
  });

  it("emits graph records whose edges always reference stored nodes", async () => {
    const res = await analyzeGraph({ ...ring(4), "src/x/hub.ts": ["../ring/m0", "../ring/m1", "../ring/m2"], "src/x/leaf.ts": [] }, { maxFileNodes: 3 });
    const keys = new Set(res.nodes.map((n) => n.key));
    expect(keys.size).toBe(res.nodes.length);
    for (const e of res.edges) {
      expect(keys.has(e.from)).toBe(true);
      expect(keys.has(e.to)).toBe(true);
    }
    expect(res.nodes.filter((n) => n.kind === "FILE")).toHaveLength(3);
    expect(res.summary.nodes).toEqual({ total: 6, stored: 3, truncated: true });
    expect(res.nodes.some((n) => n.kind === "MODULE" && n.key === "module:src/ring")).toBe(true);
  });

  it("is deterministic and fingerprints findings uniquely", async () => {
    const graph = { ...ring(3), ...ring(2, "src/other"), "src/utils/u.ts": ["../services/s"], "src/services/s.ts": [] };
    const a = await analyzeGraph(graph);
    const b = await analyzeGraph(graph);
    const strip = (r: ArchitectureAnalysis) => ({ ...r, summary: { ...r.summary, durationMs: 0 } });
    expect(strip(a)).toEqual(strip(b));
    expect(new Set(a.findings.map((f) => f.fingerprint)).size).toBe(a.findings.length);
    expect(a.findings.filter((f) => f.type === "circular-dependency")).toHaveLength(2);
  });

  it("caps stored findings", async () => {
    const graph = Object.assign({}, ...Array.from({ length: 6 }, (_, i) => ring(2, `src/c${i}`))) as Record<string, string[]>;
    const res = await analyzeGraph(graph, { maxFindings: 4 });
    expect(res.findings).toHaveLength(4);
    expect(res.summary.findings).toMatchObject({ total: 6, stored: 4, truncated: true });
  });
});

// ------------------------------------------------------------------ analyzeArchitecture (real files)

describe("analyzeArchitecture on parsed source", () => {
  it("links the polyglot fixture's imports and finds no cycles", async () => {
    const res = await analyzeDir(FIXTURE);
    const edges = fileEdges(res);
    expect(edges).toContain("src/orders.ts -> src/format.ts");
    expect(edges).toContain("native/buffer.c -> native/buffer.h");
    expect(edges.some((e) => e.startsWith("tests/"))).toBe(false);
    expect(res.summary.totals.cycles).toBe(0);
  });

  it("follows tsconfig path aliases and ESM .js specifiers read from disk", async () => {
    const res = await analyzeFiles({
      "tsconfig.json": '{\n  // aliases\n  "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] } },\n}\n',
      "src/main.ts": 'import { a } from "@lib/a";\nimport { b } from "./b.js";\nconsole.log(a, b);\n',
      "src/b.ts": 'export const b = 1;\n',
      "src/lib/a.ts": 'import { b } from "../b";\nexport const a = b;\n',
    });
    expect(fileEdges(res)).toEqual(["src/lib/a.ts -> src/b.ts", "src/main.ts -> src/b.ts", "src/main.ts -> src/lib/a.ts"]);
    expect(res.summary.resolution).toMatchObject({ tsconfigs: 1, pathAliases: 1 });
  });

  it("links `from . import module` to the module, not the package (no false cycle)", async () => {
    const res = await analyzeFiles({
      "pkg/__init__.py": "from .service import run\n",
      "pkg/service.py": "from . import models\n\n\ndef run():\n    return models.VALUE\n",
      "pkg/models.py": "VALUE = 1\n",
    });
    expect(fileEdges(res)).toEqual(["pkg/__init__.py -> pkg/service.py", "pkg/service.py -> pkg/models.py"]);
    expect(res.summary.totals.cycles).toBe(0);
  });

  it("detects a real cycle in parsed TypeScript", async () => {
    const res = await analyzeFiles({
      "src/a.ts": 'import { b } from "./b";\nexport const a = () => b();\n',
      "src/b.ts": 'import { a } from "./a";\nexport const b = () => a();\n',
    });
    expect(res.summary.totals.cycles).toBe(1);
    expect(res.findings[0]!.evidence).toBe("`src/a.ts` → `src/b.ts` → `src/a.ts`.");
  });
});
