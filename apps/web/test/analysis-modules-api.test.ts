import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { scanRepository } from "@pd/analyzer";
import { analyzeArchitecture, type ArchitectureAnalysis } from "@pd/analyzer/architecture";
import { analyzeDependencies, type DependencyAnalysis } from "@pd/analyzer/dependencies";

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

const { GET: getDependencies } = await import("@/app/api/analysis/[id]/dependencies/route");
const { GET: getArchitecture } = await import("@/app/api/analysis/[id]/architecture/route");

/** In-memory stand-in for the Prisma calls these routes make; records query arguments. */
function fakeDb(data: { analyses: Row[]; dependencies: Row[]; nodes: Row[]; edges: Row[] }) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown) => (calls[name] ??= []).push(args);
  const inList = (cond: unknown, v: unknown) => !cond || (cond as { in: unknown[] }).in.includes(v);
  return {
    calls,
    analysis: {
      findFirst: async (args: { where: { id: string; repository: { userId: string } } }) => {
        record("analysis.findFirst", args);
        return data.analyses.find((a) => a.id === args.where.id && a.userId === args.where.repository.userId) ?? null;
      },
    },
    dependency: {
      count: async (args: unknown) => (record("dependency.count", args), data.dependencies.length),
      findMany: async (args: unknown) => (record("dependency.findMany", args), data.dependencies),
      groupBy: async (args: unknown) => {
        record("dependency.groupBy", args);
        const counts = new Map<string, number>();
        for (const d of data.dependencies) counts.set(d.ecosystem as string, (counts.get(d.ecosystem as string) ?? 0) + 1);
        return [...counts].map(([ecosystem, n]) => ({ ecosystem, _count: { _all: n } }));
      },
    },
    architectureNode: {
      findMany: async (args: { where: { analysisId: string; kind: string } }) => {
        record("architectureNode.findMany", args);
        return data.nodes.filter((n) => n.analysisId === args.where.analysisId && n.kind === args.where.kind);
      },
    },
    architectureEdge: {
      findMany: async (args: { where: { analysisId: string; kind: string; fromId: unknown; toId: unknown } }) => {
        record("architectureEdge.findMany", args);
        const w = args.where;
        return data.edges.filter((e) => e.analysisId === w.analysisId && e.kind === w.kind && inList(w.fromId, e.fromId) && inList(w.toId, e.toId));
      },
    },
  };
}

// ------------------------------------------------------------------ fixture produced by the real analyzers

let root: string;
let dep: DependencyAnalysis;
let arch: ArchitectureAnalysis;
let db: ReturnType<typeof fakeDb>;

/** OSV.dev stand-in: lodash 4.17.20 has one advisory. */
const osvFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).endsWith("/querybatch")) {
    const { queries } = JSON.parse(init!.body as string) as { queries: Array<{ package: { name: string } }> };
    return Response.json({ results: queries.map((q) => (q.package.name === "lodash" ? { vulns: [{ id: "GHSA-35jh-r3h4-6jhm" }] } : {})) });
  }
  return Response.json({
    id: "GHSA-35jh-r3h4-6jhm",
    aliases: ["CVE-2021-23337"],
    summary: "Command Injection in lodash",
    severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H" }],
    affected: [{ package: { ecosystem: "npm", name: "lodash" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }],
  });
}) as typeof fetch;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "pd-web-api-test-"));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ name: "shop", dependencies: { lodash: "^4.17.0", ms: "^2.1.0" }, devDependencies: { vitest: "^5.0.0" } }),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "shop" },
        "node_modules/lodash": { version: "4.17.20" },
        "node_modules/ms": { version: "2.1.3" },
        "node_modules/vitest": { version: "5.0.0", dev: true },
      },
    }),
  };
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
  const scan = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
  dep = await analyzeDependencies(scan.files, { osv: { fetch: osvFetch } });

  // Import graph: a cycle in src/core, a consumer in src/api and an isolated file in lib.
  const graph: Record<string, string[]> = {
    "src/core/a.ts": ["./b"],
    "src/core/b.ts": ["./a"],
    "src/api/handler.ts": ["../core/a", "../core/b"],
    "lib/util.ts": [],
  };
  const paths = Object.keys(graph);
  arch = await analyzeArchitecture(
    paths.map((p) => ({ path: p, absPath: path.join(root, p), size: 10, kind: "SOURCE" as const })),
    paths.map((p) => ({ path: p, language: "typescript", imports: graph[p]!, codeLines: 5 })),
    new Map(paths.map((p) => [p, "SOURCE" as const])),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  state.user = { id: "u1", email: "u1@example.com", name: "User One" };
  // Rows shaped as the worker persists them (see apps/worker/src/persist.ts).
  const nodes = arch.nodes.map((n, i) => ({ id: `node${i}`, analysisId: "an1", key: n.key, kind: n.kind, label: n.label, layer: n.layer, metrics: n.metrics }));
  const idByKey = new Map(nodes.map((n) => [n.key, n.id]));
  db = fakeDb({
    analyses: [
      { id: "an1", userId: "u1", summary: { dependencies: dep.summary, architecture: arch.summary }, repository: {} },
      { id: "old", userId: "u1", summary: { codeMetrics: {} }, repository: {} },
      { id: "other", userId: "u2", summary: { dependencies: dep.summary }, repository: {} },
    ],
    dependencies: dep.dependencies.map((d, i) => ({
      id: `dep${i}`,
      ecosystem: d.ecosystem,
      name: d.name,
      versionSpec: d.versionSpec,
      resolvedVersion: d.resolvedVersion,
      direct: d.direct,
      dev: d.dev,
      manifestPath: d.manifestPath,
      vulnIds: d.vulnIds,
      dataSource: d.dataSource,
      unusedCandidate: d.unusedCandidate,
    })),
    nodes,
    edges: arch.edges.map((e) => ({ analysisId: "an1", fromId: idByKey.get(e.from), toId: idByKey.get(e.to), kind: e.kind, weight: e.weight, inCycle: e.inCycle })),
  });
  state.db = db;
});

const call = async (handler: typeof getDependencies, id: string, qs = "") => {
  const res = await handler(new NextRequest(`http://localhost:3000/api/analysis/${id}/x${qs}`), { params: Promise.resolve({ id }) });
  return { status: res.status, body: (await res.json()) as { success: boolean; data: unknown; error: Row } };
};

// ------------------------------------------------------------------ shared access rules

describe.each([
  ["dependencies", () => getDependencies],
  ["architecture", () => getArchitecture],
])("GET /api/analysis/:id/%s access", (_name, handler) => {
  it("requires a signed-in user", async () => {
    state.user = null;
    const { status, body } = await call(handler(), "an1");
    expect(status).toBe(401);
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("answers 404 for another user's analysis without revealing it exists", async () => {
    const other = await call(handler(), "other");
    const missing = await call(handler(), "nope");
    expect(other.status).toBe(404);
    expect(other.body.error).toMatchObject({ code: "NOT_FOUND", message: "Analysis not found" });
    expect(missing.body.error.message).toBe(other.body.error.message);
    expect(db.calls["dependency.findMany"]).toBeUndefined();
    expect(db.calls["architectureNode.findMany"]).toBeUndefined();
  });

  it("validates the id and the query", async () => {
    expect((await call(handler(), "../etc")).status).toBe(400);
    const bad = await call(handler(), "an1", "?pageSize=9999&limit=9999");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// ------------------------------------------------------------------ dependencies

describe("GET /api/analysis/:id/dependencies", () => {
  it("returns dependencies, the summary and ecosystem facets", async () => {
    const { status, body } = await call(getDependencies, "an1");
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data as unknown as {
      summary: { totals: Row; vulnerabilityScan: Row };
      dependencies: Array<Row & { vulnerability: Row | null }>;
      total: number;
      page: number;
      pageSize: number;
      facets: { ecosystem: Row[] };
    };
    expect(data).toMatchObject({ total: 3, page: 1, pageSize: 50, facets: { ecosystem: [{ value: "npm", count: 3 }] } });
    expect(data.summary.totals).toMatchObject({ dependencies: 3, vulnerable: 1 });
    expect(data.summary.vulnerabilityScan).toMatchObject({ status: "completed", source: "osv.dev" });

    const lodash = data.dependencies.find((d) => d.name === "lodash")!;
    expect(lodash).toMatchObject({ resolvedVersion: "4.17.20", direct: true, vulnIds: ["GHSA-35jh-r3h4-6jhm"], dataSource: "osv.dev" });
    expect(lodash.vulnerability).toMatchObject({ severity: "HIGH", fixedVersion: "4.17.21", advisories: [{ id: "GHSA-35jh-r3h4-6jhm", aliases: ["CVE-2021-23337"] }] });
    expect(data.dependencies.find((d) => d.name === "ms")!.vulnerability).toBeNull();
    // Internal columns are not exposed.
    expect(Object.keys(lodash)).not.toContain("analysisId");
  });

  it("passes filters, sorting and pagination to the database", async () => {
    const { status } = await call(getDependencies, "an1", "?ecosystem=npm&scope=direct&dev=exclude&vulnerable=true&q=lod&sort=manifest&page=2&pageSize=10");
    expect(status).toBe(200);
    const [findMany] = db.calls["dependency.findMany"] as Array<{ where: Row; orderBy: unknown; skip: number; take: number }>;
    expect(findMany!.where).toEqual({
      analysisId: "an1",
      ecosystem: { in: ["npm"] },
      direct: true,
      dev: false,
      vulnIds: { isEmpty: false },
      name: { contains: "lod", mode: "insensitive" },
    });
    expect(findMany).toMatchObject({ orderBy: [{ manifestPath: "asc" }, { name: "asc" }], skip: 10, take: 10 });
    // The ecosystem facet keeps the other filters but not the ecosystem filter itself.
    const [groupBy] = db.calls["dependency.groupBy"] as Array<{ where: Row }>;
    expect(groupBy!.where).not.toHaveProperty("ecosystem");
    expect(groupBy!.where).toMatchObject({ direct: true, vulnIds: { isEmpty: false } });
  });

  it("returns a null summary for analyses that predate the dependency analyzer", async () => {
    const { status, body } = await call(getDependencies, "old");
    expect(status).toBe(200);
    expect((body.data as unknown as { summary: unknown }).summary).toBeNull();
  });
});

// ------------------------------------------------------------------ architecture

describe("GET /api/analysis/:id/architecture", () => {
  type Graph = { summary: Row & { totals: Row }; view: string; nodes: Row[]; edges: Row[]; total: number; truncated: boolean };

  it("returns the module graph by default", async () => {
    const { status, body } = await call(getArchitecture, "an1");
    expect(status).toBe(200);
    const data = body.data as unknown as Graph;
    expect(data.view).toBe("modules");
    expect(data.nodes.every((n) => n.kind === "MODULE")).toBe(true);
    expect(data.nodes.map((n) => n.key).sort()).toEqual(["module:lib", "module:src/api", "module:src/core"]);
    expect(data.edges).toEqual([{ from: "module:src/api", to: "module:src/core", kind: "module", weight: 2, inCycle: false }]);
    expect(data.summary.totals).toMatchObject({ files: 4, cycles: 1, filesInCycles: 2 });
    expect(data).toMatchObject({ total: 3, truncated: false });
  });

  it("returns the file graph with cycle edges marked, addressed by node key", async () => {
    const data = (await call(getArchitecture, "an1", "?view=files")).body.data as unknown as Graph;
    expect(data.nodes.map((n) => n.key)).toEqual(["file:src/core/a.ts", "file:src/core/b.ts", "file:src/api/handler.ts", "file:lib/util.ts"]);
    expect(data.edges.map((e) => `${e.from} -> ${e.to}${e.inCycle ? " (cycle)" : ""}`).sort()).toEqual([
      "file:src/api/handler.ts -> file:src/core/a.ts",
      "file:src/api/handler.ts -> file:src/core/b.ts",
      "file:src/core/a.ts -> file:src/core/b.ts (cycle)",
      "file:src/core/b.ts -> file:src/core/a.ts (cycle)",
    ]);
    expect(JSON.stringify(data)).not.toContain("node0");
  });

  it("filters to one module or to cycles and bounds the graph", async () => {
    const core = (await call(getArchitecture, "an1", "?view=files&module=src/core")).body.data as unknown as Graph;
    expect(core.nodes.map((n) => n.label)).toEqual(["src/core/a.ts", "src/core/b.ts"]);
    expect(core.edges).toHaveLength(2);

    const cycles = (await call(getArchitecture, "an1", "?view=files&cycles=true")).body.data as unknown as Graph;
    expect(cycles.nodes.every((n) => (n.metrics as Row).inCycle === true)).toBe(true);
    expect(cycles.total).toBe(2);

    const top = (await call(getArchitecture, "an1", "?view=files&limit=1")).body.data as unknown as Graph;
    expect(top).toMatchObject({ total: 4, truncated: true });
    expect(top.nodes).toHaveLength(1);
    expect(top.edges).toEqual([]);
  });

  it("returns an empty graph and null summary for analyses that predate the architecture analyzer", async () => {
    const data = (await call(getArchitecture, "old")).body.data as unknown as Graph;
    expect(data).toMatchObject({ summary: null, nodes: [], edges: [], total: 0, truncated: false });
    expect(db.calls["architectureEdge.findMany"]).toBeUndefined();
  });
});
