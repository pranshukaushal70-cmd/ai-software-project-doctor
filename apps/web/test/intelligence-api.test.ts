import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scanRepository } from "@pd/analyzer";
import { buildRepositoryIndex, createSymbolCollector, type RepositoryIndex } from "@pd/analyzer/intelligence";
import { analyzeCode } from "@pd/analyzer/metrics";

// ------------------------------------------------------------------ mocks: session + database

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com", name: "User One" } as { id: string; email: string; name: string } | null,
  db: null as unknown,
}));

vi.mock("@/server/auth/session", async () => {
  const { AppError } = await import("@pd/shared");
  return {
    requireApiUser: async () => {
      if (!state.user) throw new AppError("UNAUTHENTICATED", "Please sign in");
      return state.user;
    },
  };
});
vi.mock("@pd/db", () => ({ getPrisma: () => state.db }));

const routes = {
  manifest: await import("@/app/api/analysis/[id]/manifest/route"),
  modules: await import("@/app/api/analysis/[id]/modules/route"),
  symbols: await import("@/app/api/analysis/[id]/symbols/route"),
  references: await import("@/app/api/analysis/[id]/references/route"),
  imports: await import("@/app/api/analysis/[id]/imports/route"),
  impact: await import("@/app/api/analysis/[id]/impact/route"),
  context: await import("@/app/api/analysis/[id]/context/route"),
};
const { clearGraphCache } = await import("@/server/services/intelligence-service");

// ------------------------------------------------------------------ fixture: a real index of a small repository

const REPO = {
  "package.json": JSON.stringify({ name: "shop-api", engines: { node: ">=22" } }),
  "src/auth/authenticate.ts": `import { findUser } from "../users/repository";
export async function authenticateUser(token: string) {
  return findUser(token);
}
`,
  "src/users/repository.ts": `export const findUser = async (id: string) => ({ id });
export function createUser(email: string) {
  return { email };
}
`,
  "src/routes/users.ts": `import express from "express";
import { authenticateUser } from "../auth/authenticate";
import { createUser } from "../users/repository";
import { gone } from "./missing";
export const router = express.Router();
router.post("/users", async (req, res) => {
  await authenticateUser("t");
  res.json(createUser("e"));
});
`,
  "src/auth/authenticate.test.ts": 'import { authenticateUser } from "./authenticate";\nit("works", () => authenticateUser("t"));\n',
};

let root: string;
let index: RepositoryIndex;
let rows: { files: Row[]; deps: Row[]; symbols: Row[]; refs: Row[] };

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "pd-intel-api-"));
  for (const [rel, text] of Object.entries(REPO)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  const scan = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
  const collector = createSymbolCollector();
  const code = await analyzeCode(scan.files, { onTree: collector.inspectTree });
  index = await buildRepositoryIndex(scan, code, collector.files(), { name: "shop", moduleDepth: 2 });
  const fileId = new Map(scan.files.map((f, i) => [f.path, `f${i}`]));
  const symbolId = new Map(index.symbols.map((s, i) => [s.key, `s${i}`]));
  rows = {
    files: scan.files.map((f) => ({ id: fileId.get(f.path), analysisId: "an1", path: f.path, kind: f.kind })),
    deps: index.dependencies.map((d) => ({ analysisId: "an1", fromFileId: fileId.get(d.from), toFileId: d.to ? fileId.get(d.to) : null, specifier: d.specifier, kind: d.kind, packageName: d.packageName })),
    symbols: index.symbols.map((s) => ({ id: symbolId.get(s.key), analysisId: "an1", fileId: fileId.get(s.path), name: s.name, kind: s.kind, parent: s.parent, exported: s.exported, isDefault: s.isDefault, line: s.line, endLine: s.endLine, signature: s.signature })),
    refs: index.references.map((r) => ({ analysisId: "an1", fileId: fileId.get(r.path), fromSymbolId: r.fromKey ? symbolId.get(r.fromKey) : null, targetSymbolId: r.targetKey ? symbolId.get(r.targetKey) : null, name: r.name, receiver: r.receiver, line: r.line })),
  };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** In-memory stand-in for the Prisma calls the intelligence service makes; counts queries. */
function fakeDb() {
  const calls: Record<string, number> = {};
  const hit = (name: string) => (calls[name] = (calls[name] ?? 0) + 1);
  const ANALYSES: Row[] = [
    {
      id: "an1",
      userId: "u1",
      status: "COMPLETED",
      repository: {},
      summary: { intelligence: index.summary, practices: { api: { list: [{ method: "POST", path: "/users", file: "src/routes/users.ts", line: 6, framework: "Express" }] } } },
    },
    { id: "old", userId: "u1", status: "COMPLETED", repository: {}, summary: { codeMetrics: {} } },
    { id: "other", userId: "u2", status: "COMPLETED", repository: {}, summary: { intelligence: index.summary } },
  ];
  const fileById = (id: unknown) => rows.files.find((f) => f.id === id);
  const symbolById = (id: unknown) => rows.symbols.find((s) => s.id === id);
  const matchSymbol = (where: Row) => (s: Row) => {
    const name = where.name as { contains: string } | undefined;
    const kind = where.kind as { in: string[] } | undefined;
    const file = where.file as { path: string } | undefined;
    return (
      s.analysisId === where.analysisId &&
      (!name || String(s.name).toLowerCase().includes(name.contains.toLowerCase())) &&
      (!kind || kind.in.includes(s.kind as string)) &&
      (!file || fileById(s.fileId)?.path === file.path) &&
      (where.exported === undefined || s.exported === where.exported)
    );
  };
  const matchRef = (where: Row) => (r: Row) => r.analysisId === where.analysisId && (where.targetSymbolId ? r.targetSymbolId === where.targetSymbolId : r.name === where.name);
  return {
    calls,
    analysis: {
      findFirst: async ({ where }: { where: { id: string; repository: { userId: string } } }) =>
        ANALYSES.find((a) => a.id === where.id && a.userId === where.repository.userId) ?? null,
    },
    file: {
      findMany: async ({ where }: { where: Row }) => (hit("file.findMany"), rows.files.filter((f) => f.analysisId === where.analysisId)),
      findUnique: async ({ where }: { where: { analysisId_path: { analysisId: string; path: string } } }) =>
        rows.files.find((f) => f.analysisId === where.analysisId_path.analysisId && f.path === where.analysisId_path.path) ?? null,
    },
    fileDependency: {
      findMany: async ({ where }: { where: Row }) => {
        hit("fileDependency.findMany");
        return rows.deps
          .filter((d) => d.analysisId === where.analysisId && (!where.kind || d.kind === where.kind) && (!where.fromFileId || d.fromFileId === where.fromFileId) && (!where.toFileId || d.toFileId === where.toFileId))
          .map((d) => ({ ...d, fromFile: fileById(d.fromFileId), toFile: d.toFileId ? fileById(d.toFileId) : null }));
      },
    },
    codeSymbol: {
      count: async ({ where }: { where: Row }) => rows.symbols.filter(matchSymbol(where)).length,
      findMany: async ({ where, skip = 0, take }: { where: Row; skip?: number; take?: number }) => {
        hit("codeSymbol.findMany");
        return rows.symbols
          .filter(matchSymbol(where))
          .slice(skip, take ? skip + take : undefined)
          .map((s) => ({ ...s, file: { path: fileById(s.fileId)!.path }, _count: { callers: rows.refs.filter((r) => r.targetSymbolId === s.id).length } }));
      },
    },
    symbolReference: {
      count: async ({ where }: { where: Row }) => rows.refs.filter(matchRef(where)).length,
      findMany: async ({ where }: { where: Row }) => {
        hit("symbolReference.findMany");
        if (!("targetSymbolId" in where) && !("name" in where)) return rows.refs.filter((r) => r.analysisId === where.analysisId);
        return rows.refs.filter(matchRef(where)).map((r) => ({ ...r, file: { path: fileById(r.fileId)!.path }, fromSymbol: r.fromSymbolId ? symbolById(r.fromSymbolId) : null }));
      },
    },
  };
}

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  db = fakeDb();
  state.db = db;
  state.user = { id: "u1", email: "u1@example.com", name: "User One" };
  clearGraphCache();
});

const ORIGIN = "http://localhost:3000";
type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
const get = async (handler: Handler, id: string, query = "") => {
  const res = await handler(new NextRequest(`${ORIGIN}/api/analysis/${id}/x${query}`), { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as { data?: Record<string, any>; error?: { code: string } } };
};
const post = async (id: string, body: unknown, headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" }) => {
  const res = await routes.context.POST(new NextRequest(`${ORIGIN}/api/analysis/${id}/context`, { method: "POST", headers, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as { data?: Record<string, any>; error?: { code: string } } };
};

describe("GET manifest / modules", () => {
  it("returns the repository manifest, totals and modules", async () => {
    const m = await get(routes.manifest.GET, "an1");
    expect(m.status).toBe(200);
    expect(m.body.data).toMatchObject({ indexed: true, manifest: { name: "shop-api", runtimes: [{ name: "Node.js", version: ">=22", evidence: "package.json: engines" }] }, symbolLanguages: ["typescript", "javascript", "python"] });
    expect(m.body.data!.totals.symbols).toBe(index.summary.totals.symbols);
    const mods = await get(routes.modules.GET, "an1");
    expect(mods.body.data!.modules).toContainEqual(expect.objectContaining({ key: "src/auth", files: 2, testFiles: 1 }));
  });
});

describe("GET symbols / references", () => {
  it("finds where a symbol is defined, with filters and pagination", async () => {
    const r = await get(routes.symbols.GET, "an1", "?q=authenticate");
    expect(r.body.data).toMatchObject({ indexed: true, total: 1 });
    expect(r.body.data!.symbols[0]).toMatchObject({ name: "authenticateUser", kind: "FUNCTION", path: "src/auth/authenticate.ts", line: 2, exported: true, callers: 2 });
    expect((await get(routes.symbols.GET, "an1", "?kind=FUNCTION&exported=true&pageSize=1")).body.data).toMatchObject({ total: 3, symbols: [expect.anything()] });
    expect((await get(routes.symbols.GET, "an1", "?path=src/users/repository.ts")).body.data!.symbols.map((s: Row) => s.name).sort()).toEqual(["createUser", "findUser"]);
  });

  it("lists who calls a function", async () => {
    const createUser = (await get(routes.symbols.GET, "an1", "?q=createUser")).body.data!.symbols[0];
    const r = await get(routes.references.GET, "an1", `?symbolId=${createUser.id}`);
    expect(r.body.data!.references).toEqual([{ path: "src/routes/users.ts", line: 8, name: "createUser", receiver: null, resolved: true, caller: null }]);
    expect((await get(routes.references.GET, "an1", "?name=findUser")).body.data!.references).toEqual([
      expect.objectContaining({ path: "src/auth/authenticate.ts", caller: "authenticateUser", resolved: true }),
    ]);
  });

  it("validates queries, including paths that try to leave the repository", async () => {
    expect((await get(routes.symbols.GET, "an1", "?kind=BOGUS")).status).toBe(400);
    expect((await get(routes.symbols.GET, "an1", "?path=../../etc/passwd")).status).toBe(400);
    expect((await get(routes.symbols.GET, "an1", "?path=/etc/passwd")).status).toBe(400);
    expect((await get(routes.imports.GET, "an1", "?path=src\\..\\x")).status).toBe(400);
    expect((await get(routes.references.GET, "an1", "")).status).toBe(400);
    expect((await get(routes.references.GET, "an1", "?name=a&symbolId=b")).status).toBe(400);
    expect((await get(routes.impact.GET, "an1", "?type=file&target=src/a.ts&depth=99")).status).toBe(400);
  });
});

describe("GET imports", () => {
  it("lists what a file imports, including packages and unresolved imports, and which files import it", async () => {
    const out = await get(routes.imports.GET, "an1", "?path=src/routes/users.ts");
    expect(out.body.data!.imports).toEqual([
      { specifier: "express", kind: "EXTERNAL", path: null, packageName: "express" },
      { specifier: "../auth/authenticate", kind: "INTERNAL", path: "src/auth/authenticate.ts", packageName: null },
      { specifier: "../users/repository", kind: "INTERNAL", path: "src/users/repository.ts", packageName: null },
      { specifier: "./missing", kind: "UNRESOLVED", path: null, packageName: null },
    ].sort((a, b) => a.kind.localeCompare(b.kind) || a.specifier.localeCompare(b.specifier)));
    const inn = await get(routes.imports.GET, "an1", "?path=src/auth/authenticate.ts&direction=importers");
    expect(inn.body.data!.importers.map((i: Row) => i.path).sort()).toEqual(["src/auth/authenticate.test.ts", "src/routes/users.ts"]);
    expect((await get(routes.imports.GET, "an1", "?path=src/nope.ts")).body.data).toMatchObject({ file: null, imports: [] });
  });
});

describe("GET impact", () => {
  it("returns dependants, tests, routes and a drawable subgraph for a file", async () => {
    const r = await get(routes.impact.GET, "an1", "?type=file&target=src/users/repository.ts");
    const impact = r.body.data!.impact;
    expect(impact.target).toMatchObject({ found: true, files: ["src/users/repository.ts"] });
    expect(impact.directDependents).toEqual(["src/auth/authenticate.ts", "src/routes/users.ts"]);
    expect(impact.relatedTests).toEqual([{ path: "src/auth/authenticate.test.ts", reason: "imports", depth: 2 }]);
    expect(impact.relatedRoutes).toEqual([expect.objectContaining({ method: "POST", path: "/users" })]);
    expect(impact.relatedConfig).toEqual([{ path: "package.json", reason: "nearest package manifest" }]);
    expect(impact.graph.nodes.map((n: Row) => n.key)).toEqual(["file:src/users/repository.ts", "file:src/auth/authenticate.ts", "file:src/routes/users.ts"]);
    expect(impact.graph.edges).toContainEqual(expect.objectContaining({ from: "file:src/routes/users.ts", to: "file:src/users/repository.ts" }));
  });

  it("limits a symbol's impact to its callers", async () => {
    const impact = (await get(routes.impact.GET, "an1", "?type=symbol&target=createUser")).body.data!.impact;
    expect(impact.directDependents).toEqual(["src/routes/users.ts"]);
    expect(impact.callers).toEqual([{ path: "src/routes/users.ts", line: 8, caller: null, resolved: true }]);
  });

  it("reuses the graph of a completed analysis instead of reloading every row", async () => {
    await get(routes.impact.GET, "an1", "?type=file&target=src/db.ts");
    await get(routes.impact.GET, "an1", "?type=module&target=src/users");
    expect(db.calls["symbolReference.findMany"]).toBe(1);
    expect(db.calls["file.findMany"]).toBe(1);
  });
});

describe("POST context (agent interface)", () => {
  it("answers structured questions", async () => {
    const ask = async (body: unknown) => (await post("an1", body)).body.data!;
    expect((await ask({ operation: "search", query: "find authentication implementation" })).result.hits[0]).toMatchObject({ type: "symbol", name: "authenticateUser" });
    expect((await ask({ operation: "find_symbol", name: "createUser" })).result.symbols).toEqual([expect.objectContaining({ path: "src/users/repository.ts", line: 2 })]);
    expect((await ask({ operation: "find_references", name: "findUser" })).result.callers).toEqual([expect.objectContaining({ path: "src/auth/authenticate.ts", resolved: true })]);
    expect((await ask({ operation: "file_importers", path: "src/users/repository.ts" })).result.importers.map((i: Row) => i.path).sort()).toEqual(["src/auth/authenticate.ts", "src/routes/users.ts"]);
    expect((await ask({ operation: "related_tests", path: "src/auth/authenticate.ts" })).result.tests).toEqual([{ path: "src/auth/authenticate.test.ts", reason: "imports", depth: 1 }]);
    expect((await ask({ operation: "find_route", query: "users" })).result.routes).toEqual([expect.objectContaining({ name: "POST /users" })]);
    expect((await ask({ operation: "manifest" })).result.manifest.name).toBe("shop-api");
    // The target type is inferred: a stored path is a file, a known directory a module, anything else a symbol.
    expect((await ask({ operation: "impact_analysis", target: "src/auth/authenticate.ts" })).result.target).toMatchObject({ type: "file", found: true });
    expect((await ask({ operation: "impact_analysis", target: "src/users" })).result.target).toMatchObject({ type: "module", found: true });
    expect((await ask({ operation: "impact_analysis", target: "authenticateUser" })).result.target).toMatchObject({ type: "symbol", found: true });
  });

  it("validates the request and requires a same-origin request", async () => {
    expect((await post("an1", { operation: "rm -rf" })).status).toBe(400);
    expect((await post("an1", { operation: "file_imports", path: "../../secret" })).status).toBe(400);
    expect((await post("an1", { operation: "search" })).status).toBe(400);
    expect((await post("an1", { operation: "manifest" }, { "content-type": "application/json" })).status).toBe(403);
    expect((await post("an1", { operation: "manifest" }, { origin: "https://evil.example", "content-type": "application/json" })).status).toBe(403);
  });
});

describe("authorization and older analyses", () => {
  const all: Array<[string, () => Promise<{ status: number }>]> = [
    ["manifest", () => get(routes.manifest.GET, "other")],
    ["modules", () => get(routes.modules.GET, "other")],
    ["symbols", () => get(routes.symbols.GET, "other")],
    ["references", () => get(routes.references.GET, "other", "?name=x")],
    ["imports", () => get(routes.imports.GET, "other", "?path=a.ts")],
    ["impact", () => get(routes.impact.GET, "other", "?type=file&target=a.ts")],
    ["context", () => post("other", { operation: "manifest" })],
  ];

  it("answers 404 for another user's analysis on every endpoint", async () => {
    for (const [name, call] of all) expect((await call()).status, name).toBe(404);
  });

  it("requires a signed-in user on every endpoint", async () => {
    state.user = null;
    for (const [name, call] of all) expect((await call()).status, name).toBe(401);
  });

  it("reports analyses made before the index existed as not indexed", async () => {
    expect((await get(routes.symbols.GET, "old", "?q=x")).body.data).toMatchObject({ indexed: false, symbols: [] });
    expect((await get(routes.manifest.GET, "old")).body.data).toMatchObject({ indexed: false, manifest: null });
    expect((await get(routes.impact.GET, "old", "?type=file&target=a.ts")).body.data).toEqual({ indexed: false, impact: null });
    expect((await post("old", { operation: "manifest" })).body.data).toEqual({ indexed: false, operation: "manifest", result: null });
  });
});
