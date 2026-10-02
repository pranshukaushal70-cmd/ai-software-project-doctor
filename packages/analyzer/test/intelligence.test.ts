import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRepositoryIndex,
  createSymbolCollector,
  fileRole,
  RepositoryGraph,
  rankFiles,
  tokenize,
  type GraphFile,
  type RepositoryIndex,
} from "../src/intelligence";
import { analyzeCode } from "../src/metrics";
import { scanRepository } from "../src/scanner";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function writeRepo(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pd-intel-test-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

/** Full pipeline on real files: scan → code metrics with the symbol collector → index. */
async function index(files: Record<string, string | Buffer>, opts: { maxFileBytes?: number; moduleDepth?: number } = {}) {
  const root = await writeRepo(files);
  const scan = await scanRepository(root, { maxFileBytes: opts.maxFileBytes ?? 1024 * 1024 });
  const collector = createSymbolCollector();
  const code = await analyzeCode(scan.files, { onTree: collector.inspectTree });
  const idx = await buildRepositoryIndex(scan, code, collector.files(), { name: "fixture", moduleDepth: opts.moduleDepth ?? 1 });
  return { root, scan, code, idx };
}

/** The in-memory query engine over an index, as the web tier builds it from stored rows. */
function graphOf(idx: RepositoryIndex, scanFiles: Array<{ path: string; kind: GraphFile["kind"] }>, routes: ConstructorParameters<typeof RepositoryGraph>[0]["routes"] = []) {
  const files = scanFiles.map((f) => ({ id: f.path, path: f.path, kind: f.kind }));
  return new RepositoryGraph({
    files,
    edges: idx.dependencies.filter((d) => d.kind === "INTERNAL").map((d) => ({ from: d.from, to: d.to! })),
    symbols: idx.symbols.map((s) => ({ id: s.key, fileId: s.path, name: s.name, kind: s.kind, parent: s.parent, exported: s.exported, line: s.line, endLine: s.endLine, signature: s.signature })),
    references: idx.references.map((r) => ({ fileId: r.path, fromSymbolId: r.fromKey, targetSymbolId: r.targetKey, name: r.name, receiver: r.receiver, line: r.line })),
    routes,
    moduleDepth: idx.summary.moduleDepth,
  });
}

const sym = (idx: RepositoryIndex, path: string) => idx.symbols.filter((s) => s.path === path).map((s) => `${s.kind} ${s.parent ? `${s.parent}.` : ""}${s.name}${s.exported ? " (exported)" : ""}${s.isDefault ? " (default)" : ""} @${s.line}`);

/** A small TypeScript service with auth, users, a route, a test and configuration. */
const APP = {
  "package.json": JSON.stringify({ name: "shop-api", engines: { node: ">=22" }, packageManager: "pnpm@9.1.0", dependencies: { express: "4", zod: "3" } }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  ".nvmrc": "22.4.0\n",
  "tsconfig.json": "{}",
  "Dockerfile": "FROM node:22-alpine AS build\nRUN npm ci\nFROM node:22-alpine\n",
  "docker-compose.yml": "services: {}\n",
  ".github/workflows/ci.yml": "jobs: {}\n",
  ".env": "DATABASE_URL=postgres://user:supersecret@db/app\n",
  ".env.example": "DATABASE_URL=\n",
  "README.md": "# Shop\n",
  "src/auth/authenticate.ts": `import jwt from "jsonwebtoken";
import { findUser } from "../users/repository";
export interface Session { userId: string }
export type Role = "admin" | "user";
export const TOKEN_TTL = 3600;
export async function authenticateUser(token: string): Promise<Session> {
  const claims = verify(token);
  return { userId: (await findUser(claims.sub)).id };
}
function verify(token: string) {
  return jwt.verify(token, "k") as { sub: string };
}
export class AuthError extends Error {
  code() {
    return this.describe();
  }
  describe() {
    return "auth";
  }
}
`,
  "src/users/repository.ts": `import { db } from "../db";
export const findUser = async (id: string) => db.users.find(id);
export function createUser(email: string) {
  return db.users.insert({ email });
}
`,
  "src/db.ts": `import { Pool } from "pg";
import "./polyfill";
export const db = new Pool() as any;
`,
  "src/polyfill.ts": "export {};\n",
  "src/routes/users.ts": `import express from "express";
import * as users from "../users/repository";
import { authenticateUser } from "../auth/authenticate";
import { missing } from "./not-there";
import fs from "node:fs";
export const router = express.Router();
router.post("/users", async (req, res) => {
  await authenticateUser(req.headers.authorization);
  res.json(users.createUser(req.body.email));
});
`,
  "src/auth/authenticate.test.ts": `import { authenticateUser } from "./authenticate";
it("authenticates", async () => {
  await authenticateUser("t");
});
`,
};

describe("symbol extraction", () => {
  it("extracts TypeScript functions, classes, methods, interfaces, types and constants with export flags", async () => {
    const { idx } = await index(APP);
    expect(sym(idx, "src/auth/authenticate.ts")).toEqual([
      "INTERFACE Session (exported) @3",
      "TYPE Role (exported) @4",
      "CONSTANT TOKEN_TTL (exported) @5",
      "FUNCTION authenticateUser (exported) @6",
      "FUNCTION verify @10",
      "CLASS AuthError (exported) @13",
      "METHOD AuthError.code @14",
      "METHOD AuthError.describe @17",
    ]);
    expect(idx.symbols.find((s) => s.name === "authenticateUser")?.signature).toBe("authenticateUser(token: string): Promise<Session>");
    expect(sym(idx, "src/users/repository.ts")).toEqual(["FUNCTION findUser (exported) @2", "FUNCTION createUser (exported) @3"]);
  });

  it("extracts CommonJS and default exports in JavaScript", async () => {
    const { idx } = await index({
      "lib/math.js": `function add(a, b) { return a + b; }
const PI = 3.14;
let counter = 0;
exports.mul = (a, b) => a * b;
module.exports = { add, PI };
`,
      "lib/main.js": `const { add } = require("./math");
const math = require("./math");
export default function main() { return add(1, math.mul(2, 3)); }
`,
    });
    expect(sym(idx, "lib/math.js")).toEqual(["FUNCTION add (exported) @1", "CONSTANT PI (exported) @2", "VARIABLE counter @3", "FUNCTION mul (exported) @4"]);
    expect(sym(idx, "lib/main.js")).toEqual(["FUNCTION main (exported) (default) @3"]);
    const refs = idx.references.filter((r) => r.path === "lib/main.js").map((r) => `${r.name}→${r.targetKey ?? "?"}`);
    expect(refs).toEqual(["add→lib/math.js#add", "mul→lib/math.js#mul"]);
  });

  it("extracts Python functions, classes, methods, constants and honours __all__", async () => {
    const { idx } = await index({
      "app/services.py": `import os
from .models import User as U
MAX_USERS = 100
_cache = {}
__all__ = ["create_user", "UserService"]

def create_user(name):
    return U(name)

def _helper():
    return 1

class UserService:
    def register(self, name):
        return self.save(create_user(name))
    def save(self, user):
        return user
`,
      "app/models.py": "class User:\n    def __init__(self, name):\n        self.name = name\n",
    });
    expect(sym(idx, "app/services.py")).toEqual([
      "CONSTANT MAX_USERS @3",
      "FUNCTION create_user (exported) @7",
      "FUNCTION _helper @10",
      "CLASS UserService (exported) @13",
      "METHOD UserService.register @14",
      "METHOD UserService.save @16",
    ]);
    const refs = idx.references.filter((r) => r.path === "app/services.py").map((r) => `${r.name}→${r.targetKey ?? "?"}`);
    // `U(name)` is the imported class, `self.save` the method, `create_user` the local function.
    expect(refs).toEqual(["U→app/models.py#User", "save→app/services.py#UserService.save", "create_user→app/services.py#create_user"]);
  });

  it("survives malformed and empty files", async () => {
    const { idx, code } = await index({ "src/broken.ts": "export function ok() {}\nexport function (((\n", "src/empty.ts": "", "src/broken.py": "def x(:\n  pass\n" });
    expect(code.files.map((f) => f.path).sort()).toEqual(["src/broken.py", "src/broken.ts", "src/empty.ts"]);
    expect(idx.symbols.some((s) => s.path === "src/broken.ts" && s.name === "ok")).toBe(true);
  });
});

describe("file roles and manifest", () => {
  it("classifies files by role from their path", () => {
    expect(fileRole("package.json", "CONFIG")).toBe("manifest");
    expect(fileRole("package-lock.json", "GENERATED")).toBe("lockfile");
    expect(fileRole(".env", "CONFIG")).toBe("secret");
    expect(fileRole(".env.example", "CONFIG")).toBe("config");
    expect(fileRole("certs/server.key", "OTHER")).toBe("secret");
    expect(fileRole("Dockerfile", "CONFIG")).toBe("infrastructure");
    expect(fileRole("infra/main.tf", "OTHER")).toBe("infrastructure");
    expect(fileRole("deploy/migrate.py", "SOURCE")).toBe("source");
    expect(fileRole(".github/workflows/ci.yml", "CONFIG")).toBe("infrastructure");
    expect(fileRole("docs/guide.md", "DOCUMENTATION")).toBe("documentation");
    expect(fileRole("src/a.test.ts", "TEST")).toBe("test");
  });

  it("builds the manifest: runtimes, manifests, lockfiles, Docker, CI and directories", async () => {
    const { idx } = await index(APP);
    const m = idx.summary.manifest;
    expect(m.name).toBe("shop-api");
    expect(m.runtimes).toEqual([
      { name: "Node.js", version: "22.4.0", evidence: ".nvmrc" },
      { name: "Node.js", version: ">=22", evidence: "package.json: engines" },
      { name: "pnpm", version: "9.1.0", evidence: "package.json: packageManager" },
      { name: "Node.js", version: "22-alpine", evidence: "Dockerfile: FROM" },
    ]);
    expect(m.manifests).toEqual([{ path: "package.json", ecosystem: "npm" }]);
    expect(m.lockfiles).toEqual(["pnpm-lock.yaml"]);
    expect(m.docker).toEqual({ dockerfiles: ["Dockerfile"], compose: ["docker-compose.yml"] });
    expect(m.infrastructure).toEqual(expect.arrayContaining([".github/workflows/ci.yml", "Dockerfile"]));
    expect(m.sourceDirs).toEqual([{ path: "src", files: 5 }]);
    expect(m.testDirs).toEqual([{ path: "src", files: 1 }]);
    expect(m.frameworks.map((f) => f.name)).toContain("Express");
    expect(m.secretFiles).toEqual([".env"]);
    expect(m.roles).toMatchObject({ source: 5, test: 1, manifest: 1, lockfile: 1, secret: 1, infrastructure: 3, documentation: 1 });
  });

  it("never puts the contents of secret files into the index", async () => {
    const { idx } = await index(APP);
    expect(JSON.stringify(idx)).not.toContain("supersecret");
  });

  it("does not trust repository-supplied version strings", async () => {
    const { idx } = await index({ ".nvmrc": "$(rm -rf /) <script>\n", ".python-version": "3.12.1\n", "a.py": "x = 1\n" });
    expect(idx.summary.manifest.runtimes).toEqual([{ name: "Python", version: "3.12.1", evidence: ".python-version" }]);
  });
});

describe("ingestion", () => {
  it("skips ignored directories, gitignored, binary, oversized and symlinked files, and hashes the rest", async () => {
    const root = await writeRepo({
      ".gitignore": "secret-notes.txt\nlogs/\n",
      "src/a.ts": "export const a = 1;\n",
      "src/big.ts": `export const big = "${"x".repeat(5000)}";\n`,
      "node_modules/lib/index.js": "module.exports = 1;\n",
      "dist/out.js": "x\n",
      ".next/cache/x.js": "x\n",
      "secret-notes.txt": "pw\n",
      "logs/app.log": "x\n",
      "assets/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]),
    });
    let symlinked = true;
    await symlink(path.join(root, "src", "a.ts"), path.join(root, "src", "link.ts")).catch(() => (symlinked = false));
    const scan = await scanRepository(root, { maxFileBytes: 1024 });
    expect(scan.files.map((f) => f.path)).toEqual([".gitignore", "assets/logo.png", "src/a.ts", "src/big.ts"]);
    expect(scan.ignored.dirs).toEqual(expect.arrayContaining([".next", "dist", "logs", "node_modules"]));
    if (symlinked) expect(scan.ignored.symlinksSkipped).toBe(1);
    const byPath = new Map(scan.files.map((f) => [f.path, f]));
    expect(byPath.get("assets/logo.png")).toMatchObject({ kind: "BINARY", contentHash: null });
    expect(byPath.get("src/big.ts")).toMatchObject({ oversized: true, contentHash: null, lines: null });
    expect(byPath.get("src/a.ts")?.contentHash).toBe(createHash("sha256").update("export const a = 1;\n").digest("hex"));
    // Deterministic: the same content hashes the same in another checkout.
    const again = await scanRepository(await writeRepo({ "src/a.ts": "export const a = 1;\n" }), { maxFileBytes: 1024 });
    expect(again.files[0]!.contentHash).toBe(byPath.get("src/a.ts")!.contentHash);
    expect(byPath.get("src/a.ts")!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("indexes only what was scanned: imports escaping the repository root stay unresolved", async () => {
    const { idx } = await index({ "src/a.ts": 'import x from "../../../etc/passwd";\nimport y from "/etc/hosts";\nexport const a = 1;\n' });
    expect(idx.dependencies.filter((d) => d.from === "src/a.ts").map((d) => `${d.kind} ${d.specifier} ${d.to}`)).toEqual([
      "UNRESOLVED ../../../etc/passwd null",
      "UNRESOLVED /etc/hosts null",
    ]);
  });
});

describe("dependency graph", () => {
  it("resolves internal, external, builtin and unresolved imports, including tests and side-effect imports", async () => {
    const { idx } = await index(APP);
    const deps = idx.dependencies.filter((d) => d.from === "src/routes/users.ts").map((d) => `${d.kind} ${d.specifier}${d.to ? ` → ${d.to}` : ""}${d.packageName ? ` (${d.packageName})` : ""}`);
    expect(deps.sort()).toEqual([
      "BUILTIN node:fs",
      "EXTERNAL express (express)",
      "INTERNAL ../auth/authenticate → src/auth/authenticate.ts",
      "INTERNAL ../users/repository → src/users/repository.ts",
      "UNRESOLVED ./not-there",
    ]);
    expect(idx.dependencies).toContainEqual(expect.objectContaining({ from: "src/db.ts", to: "src/polyfill.ts", kind: "INTERNAL" }));
    expect(idx.dependencies).toContainEqual(expect.objectContaining({ from: "src/auth/authenticate.test.ts", to: "src/auth/authenticate.ts" }));
    expect(idx.summary.totals).toMatchObject({ internalDependencies: 6, externalDependencies: 3, unresolvedDependencies: 1, builtinDependencies: 1, externalPackages: 3 });
    expect(idx.summary.unresolvedImports).toEqual([{ path: "src/routes/users.ts", specifier: "./not-there" }]);
  });

  it("resolves calls to imported functions and namespace members, and keeps only repository-relevant calls", async () => {
    const { idx } = await index(APP);
    const refs = idx.references.filter((r) => r.path === "src/routes/users.ts").map((r) => `${r.name}@${r.line}→${r.targetKey ?? "?"}`);
    // `express.Router()`, `res.json()` and `router.post()` call library code and are not indexed.
    expect(refs).toEqual(["authenticateUser@8→src/auth/authenticate.ts#authenticateUser", "createUser@9→src/users/repository.ts#createUser"]);
    const inAuth = idx.references.filter((r) => r.path === "src/auth/authenticate.ts").map((r) => `${r.fromKey}: ${r.name}→${r.targetKey}`);
    // `jwt.verify()` inside verify() calls the library, not the local verify(): not indexed.
    expect(inAuth).toEqual([
      "src/auth/authenticate.ts#authenticateUser: verify→src/auth/authenticate.ts#verify",
      "src/auth/authenticate.ts#authenticateUser: findUser→src/users/repository.ts#findUser",
      "src/auth/authenticate.ts#AuthError.code: describe→src/auth/authenticate.ts#AuthError.describe",
    ]);
  });

  it("detects import cycles and ranks the most depended-upon files", async () => {
    const { idx } = await index({
      "src/a.ts": 'import { b } from "./b";\nexport const a = () => b();\n',
      "src/b.ts": 'import { a } from "./a";\nimport { util } from "./util";\nexport const b = () => util(a);\n',
      "src/c.ts": 'import { util } from "./util";\nexport const c = util;\n',
      "src/util.ts": "export const util = (x?: unknown) => x;\n",
    });
    expect(idx.summary.cycles).toEqual([{ files: ["src/a.ts", "src/b.ts"] }]);
    expect(idx.summary.topFiles[0]).toMatchObject({ path: "src/util.ts", fanIn: 2 });
    const rank = rankFiles(["x", "y", "z"], [{ from: "x", to: "z" }, { from: "y", to: "z" }]);
    expect(rank.get("z")!).toBeGreaterThan(rank.get("x")!);
    expect([...rank.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
  });

  it("summarises modules with files, tests and symbols", async () => {
    const { idx } = await index(APP, { moduleDepth: 2 });
    expect(idx.summary.modules).toEqual(
      expect.arrayContaining([
        { key: "src/auth", files: 2, sourceFiles: 1, testFiles: 1, symbols: 8, exported: 5 },
        { key: "src/users", files: 1, sourceFiles: 1, testFiles: 0, symbols: 2, exported: 2 },
      ]),
    );
  });
});

describe("queries and impact analysis", () => {
  const routes = [{ method: "POST", path: "/users", file: "src/routes/users.ts", line: 7, framework: "Express" }];
  const appGraph = async () => {
    const { idx, scan } = await index(APP, { moduleDepth: 2 });
    return graphOf(idx, scan.files, routes);
  };

  it("answers where a symbol is defined, who imports a file and who calls a function", async () => {
    const g = await appGraph();
    expect(g.findSymbols("authenticateUser")).toEqual([expect.objectContaining({ path: "src/auth/authenticate.ts", line: 6, kind: "FUNCTION", exported: true })]);
    expect(g.importers("src/auth/authenticate.ts")).toEqual(["src/auth/authenticate.test.ts", "src/routes/users.ts"]);
    expect(g.imports("src/auth/authenticate.ts")).toEqual(["src/users/repository.ts"]);
    const createUser = g.findSymbols("createUser")[0]!;
    expect(g.callers(createUser.id)).toEqual([{ path: "src/routes/users.ts", line: 9, caller: null, resolved: true }]);
  });

  it("computes the impact of a file change: dependants, tests, routes, config and modules", async () => {
    const g = await appGraph();
    const r = g.impact({ type: "file", path: "src/users/repository.ts" });
    expect(r.target).toMatchObject({ found: true, files: ["src/users/repository.ts"] });
    expect(r.dependencies).toEqual(["src/db.ts"]);
    expect(r.directDependents).toEqual(["src/auth/authenticate.ts", "src/routes/users.ts"]);
    expect(r.transitiveDependents).toEqual([
      { path: "src/auth/authenticate.ts", depth: 1 },
      { path: "src/routes/users.ts", depth: 1 },
      { path: "src/auth/authenticate.test.ts", depth: 2 },
    ]);
    expect(r.relatedTests).toEqual([{ path: "src/auth/authenticate.test.ts", reason: "imports", depth: 2 }]);
    expect(r.relatedRoutes).toEqual(routes);
    expect(r.relatedConfig).toEqual([
      { path: "package.json", reason: "nearest package manifest" },
      { path: "pnpm-lock.yaml", reason: "lockfile of that manifest" },
    ]);
    expect(r.affectedModules).toEqual([
      { module: "src/auth", files: 2 },
      { module: "src/routes", files: 1 },
      { module: "src/users", files: 1 },
    ]);
  });

  it("limits impact to callers for a symbol, and respects the depth limit", async () => {
    const g = await appGraph();
    const r = g.impact({ type: "symbol", name: "createUser" });
    // authenticate.ts imports repository.ts but never calls createUser: it is not a dependant of this function.
    expect(r.directDependents).toEqual(["src/routes/users.ts"]);
    expect(r.callers).toEqual([{ path: "src/routes/users.ts", line: 9, caller: null, resolved: true }]);
    expect(r.relatedRoutes).toEqual(routes);
    const shallow = g.impact({ type: "file", path: "src/users/repository.ts" }, { depth: 1 });
    expect(shallow.transitiveDependents.map((d) => d.path)).toEqual(["src/auth/authenticate.ts", "src/routes/users.ts"]);
  });

  it("finds tests named after a file even when they do not import it, and analyses whole modules", async () => {
    const { idx, scan } = await index({ "src/orders.ts": "export const total = 1;\n", "tests/orders.test.ts": 'it("x", () => {});\n' });
    const g = graphOf(idx, scan.files);
    expect(g.relatedTests([g.fileByPath("src/orders.ts")!.id])).toEqual([{ path: "tests/orders.test.ts", reason: "name", depth: null }]);
    const app = await appGraph();
    const m = app.impact({ type: "module", module: "src/users" });
    expect(m.target.files).toEqual(["src/users/repository.ts"]);
    expect(m.directDependents).toEqual(["src/auth/authenticate.ts", "src/routes/users.ts"]);
  });

  it("reports an unknown target instead of guessing", async () => {
    const g = await appGraph();
    expect(g.impact({ type: "file", path: "src/nope.ts" })).toMatchObject({ target: { found: false, files: [] }, directDependents: [], relatedTests: [] });
    expect(g.impact({ type: "symbol", name: "doesNotExist" }).target.found).toBe(false);
  });

  it("searches symbols, files and routes by keyword, deterministically", async () => {
    const g = await appGraph();
    const hits = g.search("find authentication implementation");
    expect(hits[0]).toMatchObject({ type: "symbol", name: "authenticateUser", path: "src/auth/authenticate.ts" });
    expect(g.search("users route").some((h) => h.type === "route" && h.name === "POST /users")).toBe(true);
    expect(g.search("find authentication implementation")).toEqual(hits);
    expect(g.search("!!")).toEqual([]);
    expect(tokenize("createUserSession snake_case HTTPServer")).toEqual(["create", "user", "session", "snake", "case", "http", "server"]);
  });
});
