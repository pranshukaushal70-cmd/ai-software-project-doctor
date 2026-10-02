import type { Detection, RepositoryScan } from "../scanner";
import { FILE_ROLES, fileRole, LOCKFILE, MANIFEST_FILE, type FileRole } from "./roles";

/**
 * Repository manifest: what a repository is made of and how it is built, run,
 * tested and deployed. Every entry names the file it was derived from.
 * Configuration is read as text from a short list of small, well-known files;
 * secret material (`.env`, keys) is never read.
 */

export interface RuntimeVersion {
  name: string;
  version: string;
  evidence: string;
}

export interface RepositoryManifest {
  name: string;
  primaryLanguage: string | null;
  languages: Array<{ language: string; files: number; lines: number; share: number }>;
  frameworks: Detection[];
  testFrameworks: Detection[];
  packageManagers: Detection[];
  buildSystems: Detection[];
  runtimes: RuntimeVersion[];
  manifests: Array<{ path: string; ecosystem: string }>;
  lockfiles: string[];
  docker: { dockerfiles: string[]; compose: string[] };
  ci: Detection[];
  infrastructure: string[];
  entryPoints: Detection[];
  sourceDirs: Array<{ path: string; files: number }>;
  testDirs: Array<{ path: string; files: number }>;
  documentation: string[];
  configFiles: string[];
  /** Paths of files that hold secrets by convention (`.env`, keys); listed so they can be excluded, never read. */
  secretFiles: string[];
  roles: Record<FileRole, number>;
}

export type SmallFileReader = (relPath: string) => Promise<string | null>;

const LIST_LIMIT = 200;
const VERSION = /^[\w.+*^~<>=!, |-]{1,40}$/;
const ECOSYSTEM: Array<[RegExp, string]> = [
  [/^package\.json$|^deno\.jsonc?$/, "npm"],
  [/^requirements[^/]*\.txt$|^pyproject\.toml$|^Pipfile$|^setup\.(?:py|cfg)$/, "PyPI"],
  [/^pom\.xml$|^(?:build|settings)\.gradle(?:\.kts)?$/, "Maven"],
  [/^go\.mod$/, "Go"],
  [/^Cargo\.toml$/, "crates.io"],
  [/^composer\.json$/, "Packagist"],
  [/^Gemfile$/, "RubyGems"],
  [/\.csproj$/, "NuGet"],
];
const DOCKER_RUNTIMES: Record<string, string> = {
  node: "Node.js",
  python: "Python",
  openjdk: "Java",
  "eclipse-temurin": "Java",
  amazoncorretto: "Java",
  golang: "Go",
  rust: "Rust",
  ruby: "Ruby",
  php: "PHP",
};
const TOOL_VERSIONS: Record<string, string> = { nodejs: "Node.js", node: "Node.js", python: "Python", java: "Java", golang: "Go", rust: "Rust", ruby: "Ruby" };
/** Top-level directories that hold several packages: group sources one level deeper. */
const MONOREPO_DIRS = new Set(["packages", "apps", "services", "libs", "modules", "projects"]);

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const clean = (v: string | undefined | null) => {
  const t = (v ?? "").trim().replace(/^["']|["']$/g, "");
  return VERSION.test(t) ? t : null;
};

function groupDir(path: string): string {
  const segs = path.split("/");
  if (segs.length === 1) return ".";
  if (MONOREPO_DIRS.has(segs[0]!) && segs.length > 2) return `${segs[0]}/${segs[1]}`;
  return segs[0]!;
}

function topDirs(paths: readonly string[]): Array<{ path: string; files: number }> {
  const counts = new Map<string, number>();
  for (const p of paths) counts.set(groupDir(p), (counts.get(groupDir(p)) ?? 0) + 1);
  return [...counts]
    .map(([path, files]) => ({ path, files }))
    .sort((a, b) => b.files - a.files || a.path.localeCompare(b.path))
    .slice(0, 50);
}

async function detectRuntimes(paths: readonly string[], read: SmallFileReader): Promise<RuntimeVersion[]> {
  const out: RuntimeVersion[] = [];
  const add = (name: string, version: string | null, evidence: string) => {
    if (version && !out.some((r) => r.name === name && r.version === version && r.evidence === evidence)) out.push({ name, version, evidence });
  };
  const has = new Set(paths);
  const text = async (p: string) => (has.has(p) ? read(p) : null);

  for (const f of [".nvmrc", ".node-version"]) add("Node.js", clean((await text(f))?.split(/\r?\n/)[0]), f);
  const pkgText = await text("package.json");
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { engines?: Record<string, unknown>; packageManager?: unknown };
      for (const [engine, version] of Object.entries(pkg.engines ?? {})) {
        if (typeof version === "string") add(engine === "node" ? "Node.js" : engine, clean(version), "package.json: engines");
      }
      if (typeof pkg.packageManager === "string") {
        const [pm, version] = pkg.packageManager.split("@");
        if (pm && /^[\w-]+$/.test(pm)) add(pm, clean(version?.split("+")[0]), "package.json: packageManager");
      }
    } catch {
      // not JSON; ignored
    }
  }
  add("Python", clean((await text(".python-version"))?.split(/\r?\n/)[0]), ".python-version");
  add("Python", clean(/^python-([\d.]+)/m.exec((await text("runtime.txt")) ?? "")?.[1]), "runtime.txt");
  add("Python", clean(/^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec((await text("pyproject.toml")) ?? "")?.[1]), "pyproject.toml: requires-python");
  for (const line of ((await text(".tool-versions")) ?? "").split(/\r?\n/)) {
    const [tool, version] = line.trim().split(/\s+/);
    if (tool && TOOL_VERSIONS[tool]) add(TOOL_VERSIONS[tool]!, clean(version), ".tool-versions");
  }
  add("Go", clean(/^go\s+(\d+\.\d+(?:\.\d+)?)\s*$/m.exec((await text("go.mod")) ?? "")?.[1]), "go.mod");
  for (const f of ["rust-toolchain", "rust-toolchain.toml"]) {
    const t = await text(f);
    if (t) add("Rust", clean(/channel\s*=\s*["']([^"']+)["']/.exec(t)?.[1] ?? t.split(/\r?\n/)[0]), f);
  }
  const pom = await text("pom.xml");
  if (pom) add("Java", clean(/<(?:java\.version|maven\.compiler\.(?:source|release))>([^<]+)</.exec(pom)?.[1]), "pom.xml");
  for (const p of paths.filter((p) => /^Dockerfile(?:\.[\w-]+)?$|\.dockerfile$/i.test(base(p))).slice(0, 20)) {
    const t = await read(p);
    for (const m of (t ?? "").matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(?:[\w.-]+\/)?([\w.-]+)(?::([\w.-]+))?/gim)) {
      const runtime = DOCKER_RUNTIMES[m[1]!.toLowerCase()];
      if (runtime) add(runtime, clean(m[2] ?? "latest"), `${p}: FROM`);
    }
  }
  return out;
}

export async function buildManifest(scan: RepositoryScan, opts: { name: string; read: SmallFileReader }): Promise<RepositoryManifest> {
  const roles = Object.fromEntries(FILE_ROLES.map((r) => [r, 0])) as Record<FileRole, number>;
  const byRole = new Map<FileRole, string[]>();
  for (const f of scan.files) {
    const role = fileRole(f.path, f.kind);
    roles[role]++;
    const list = byRole.get(role) ?? [];
    list.push(f.path);
    byRole.set(role, list);
  }
  const paths = scan.files.map((f) => f.path);
  const totalLines = scan.languages.reduce((n, l) => n + l.lines, 0);
  const manifestPaths = byRole.get("manifest") ?? [];
  const infra = byRole.get("infrastructure") ?? [];

  let name = opts.name;
  const pkg = await opts.read("package.json").catch(() => null);
  if (pkg) {
    try {
      const n = (JSON.parse(pkg) as { name?: unknown }).name;
      if (typeof n === "string" && /^[@\w./-]{1,100}$/.test(n)) name = n;
    } catch {
      // not JSON; keep the repository name
    }
  }

  return {
    name,
    primaryLanguage: scan.primaryLanguage,
    languages: scan.languages.map((l) => ({ language: l.language, files: l.files, lines: l.lines, share: totalLines ? Math.round((l.lines / totalLines) * 1000) / 10 : 0 })),
    frameworks: scan.frameworks.filter((d) => d.category !== "testing"),
    testFrameworks: scan.frameworks.filter((d) => d.category === "testing"),
    packageManagers: scan.packageManagers,
    buildSystems: scan.buildSystems,
    runtimes: await detectRuntimes(paths, opts.read),
    manifests: manifestPaths
      .filter((p) => MANIFEST_FILE.test(base(p)))
      .map((p) => ({ path: p, ecosystem: ECOSYSTEM.find(([re]) => re.test(base(p)))?.[1] ?? "other" }))
      .slice(0, LIST_LIMIT),
    lockfiles: paths.filter((p) => LOCKFILE.test(base(p))).slice(0, LIST_LIMIT),
    docker: {
      dockerfiles: infra.filter((p) => /^Dockerfile(?:\..+)?$|\.dockerfile$/i.test(base(p))).slice(0, LIST_LIMIT),
      compose: infra.filter((p) => /^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/i.test(base(p))).slice(0, LIST_LIMIT),
    },
    ci: scan.ci,
    infrastructure: infra.slice(0, LIST_LIMIT),
    entryPoints: scan.entryPoints,
    sourceDirs: topDirs(byRole.get("source") ?? []),
    testDirs: topDirs(byRole.get("test") ?? []),
    documentation: (byRole.get("documentation") ?? []).slice(0, LIST_LIMIT),
    configFiles: (byRole.get("config") ?? []).slice(0, LIST_LIMIT),
    secretFiles: (byRole.get("secret") ?? []).slice(0, LIST_LIMIT),
    roles,
  };
}
