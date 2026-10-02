import { stripJsonc } from "../architecture/resolve";
import { escapeRe, lineOf, type DependencyRecord, type DependencySource, type ParsedManifest } from "./types";

const PUBLIC_NPM_REGISTRIES = /^https:\/\/registry\.(npmjs\.org|yarnpkg\.com|npmmirror\.com)\//;

/** True for the public npm registries (and their mirrors); `https://registry.npmjs.org` works with or without a trailing slash. */
export function isPublicNpmRegistry(url: string): boolean {
  const u = url.trim();
  return PUBLIC_NPM_REGISTRIES.test(u.endsWith("/") ? u : `${u}/`);
}

/** Registry settings committed to the repository (`.npmrc`, `.yarnrc.yml`). Scopes include the `@`. */
export interface NpmRegistryConfig {
  registry: string | null;
  scopes: Map<string, string>;
}

const unquoteValue = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");

/**
 * Registry lines of an `.npmrc` (`registry=…`, `@scope:registry=…`) or `.yarnrc.yml`
 * (`npmRegistryServer`, `npmScopes.<scope>.npmRegistryServer`). Every other
 * setting, including auth tokens, is ignored and never returned.
 */
export function parseNpmRegistryConfig(fileName: string, text: string): NpmRegistryConfig {
  const config: NpmRegistryConfig = { registry: null, scopes: new Map() };
  const lines = text.split(/\r?\n/);
  if (fileName === ".npmrc") {
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const m = /^(@[^:\s=]+:)?registry\s*=\s*(.+)$/.exec(line);
      if (!m) continue;
      if (m[1]) config.scopes.set(m[1].slice(0, -1), unquoteValue(m[2]!));
      else config.registry = unquoteValue(m[2]!);
    }
    return config;
  }
  // .yarnrc.yml: top-level npmRegistryServer, and npmScopes: { <scope>: { npmRegistryServer } } (scope written without @).
  let inScopes = false;
  let scope: string | null = null;
  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (indent === 0) {
      inScopes = /^npmScopes\s*:\s*$/.test(line);
      scope = null;
      const top = /^npmRegistryServer\s*:\s*(.+)$/.exec(line);
      if (top) config.registry = unquoteValue(top[1]!);
      continue;
    }
    if (!inScopes) continue;
    const key = /^["']?@?([^"':\s]+)["']?\s*:\s*$/.exec(line);
    if (key && indent <= 2) {
      scope = `@${key[1]}`;
      continue;
    }
    const server = /^npmRegistryServer\s*:\s*(.+)$/.exec(line);
    if (server && scope) config.scopes.set(scope, unquoteValue(server[1]!));
  }
  return config;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Classify an npm version spec by where the package comes from. */
export function npmSource(spec: string): DependencySource {
  const s = spec.trim();
  if (/^workspace:/.test(s)) return "workspace";
  if (/^(file|link|portal):/.test(s)) return "path";
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|gist:)/.test(s) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(s)) return "git";
  if (/^https?:\/\//.test(s)) return "url";
  return "registry";
}

/** An exact semver version (optionally written as `=1.2.3` or `v1.2.3`), or null for ranges. */
export function exactNpmVersion(spec: string): string | null {
  const m = /^\s*(?:=|v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\s*$/.exec(spec);
  return m ? m[1]! : null;
}

export const DEPENDENCY_FIELDS = [
  ["dependencies", false],
  ["optionalDependencies", false],
  ["peerDependencies", false],
  ["devDependencies", true],
] as const;

/** Direct dependencies declared in a package.json. */
export function parsePackageJson(path: string, text: string): ParsedManifest | null {
  const pkg = parseJson(text);
  if (!pkg) return null;
  const lines = text.split(/\r?\n/);
  const deps: DependencyRecord[] = [];
  const seen = new Set<string>();
  for (const [field, dev] of DEPENDENCY_FIELDS) {
    const table = pkg[field];
    if (!isRecord(table)) continue;
    const fieldLine = lineOf(lines, new RegExp(`"${field}"\\s*:`)) ?? 1;
    for (const [name, raw] of Object.entries(table)) {
      if (typeof raw !== "string" || seen.has(name)) continue;
      // peerDependencies usually repeat a devDependency; the first declaration wins.
      seen.add(name);
      const source = npmSource(raw);
      deps.push({
        ecosystem: "npm",
        name,
        versionSpec: raw,
        resolvedVersion: source === "registry" ? exactNpmVersion(raw) : null,
        direct: true,
        dev,
        manifestPath: path,
        line: lineOf(lines, new RegExp(`^\\s*"${escapeRe(name)}"\\s*:`), fieldLine - 1),
        source,
        publicRegistry: true,
      });
    }
  }
  return { path, ecosystem: "npm", kind: "manifest", dependencies: deps };
}

/** Workspace package name and directory, for resolving monorepo imports. */
export function packageJsonName(text: string): string | null {
  const pkg = parseJson(text);
  return pkg && typeof pkg.name === "string" ? pkg.name : null;
}

export interface LockedPackage {
  name: string;
  version: string;
  dev: boolean;
  /** Install location relative to the lockfile directory, e.g. `node_modules/a/node_modules/b` (package-lock only). */
  location: string | null;
  line: number | null;
  publicRegistry: boolean;
  /**
   * True when the lockfile names the registry or URL this package was fetched from.
   * When false, the package came from the configured default registry, which the
   * lockfile does not record; `publicRegistry` is then decided from `.npmrc`/`.yarnrc.yml`.
   */
  registryRecorded: boolean;
  /** Other specs that resolve to this entry (`name@^1.0.0`, yarn/pnpm), for matching direct dependencies. */
  specs: string[];
}

/** package-lock.json / npm-shrinkwrap.json, lockfileVersion 1–3. */
export function parsePackageLock(text: string): LockedPackage[] {
  const lock = parseJson(text);
  if (!lock) return [];
  const lines = text.split(/\r?\n/);
  const keyLines = new Map<string, number>();
  lines.forEach((l, i) => {
    const m = /^\s*"((?:[^"\\]|\\.)*node_modules\/(?:[^"\\]|\\.)*)"\s*:\s*\{/.exec(l);
    if (m && !keyLines.has(m[1]!)) keyLines.set(m[1]!, i + 1);
  });
  const out: LockedPackage[] = [];
  // A `resolved` URL names the registry; without one, the package came from the configured default registry.
  const recorded = (resolved: unknown): resolved is string => typeof resolved === "string" && /^https?:/.test(resolved);
  const registry = (resolved: unknown) =>
    recorded(resolved) ? { publicRegistry: isPublicNpmRegistry(resolved), registryRecorded: true } : { publicRegistry: true, registryRecorded: false };

  if (isRecord(lock.packages)) {
    for (const [location, entry] of Object.entries(lock.packages)) {
      if (!location.includes("node_modules/") || !isRecord(entry) || entry.link === true) continue;
      if (typeof entry.version !== "string") continue;
      const name = typeof entry.name === "string" ? entry.name : location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length);
      const resolved = entry.resolved;
      // Git and tarball dependencies are not registry packages.
      if (typeof resolved === "string" && /^(git\+|git:|file:)/.test(resolved)) continue;
      out.push({
        name,
        version: entry.version,
        dev: entry.dev === true || entry.devOptional === true,
        location,
        line: keyLines.get(location) ?? null,
        ...registry(resolved),
        specs: [],
      });
    }
    return out;
  }

  // lockfileVersion 1: nested `dependencies` objects.
  const stack: Array<{ deps: Record<string, unknown>; prefix: string }> = isRecord(lock.dependencies) ? [{ deps: lock.dependencies, prefix: "" }] : [];
  while (stack.length > 0 && out.length < 200_000) {
    const { deps, prefix } = stack.pop()!;
    for (const [name, entry] of Object.entries(deps)) {
      if (!isRecord(entry) || typeof entry.version !== "string") continue;
      const location = `${prefix}node_modules/${name}`;
      if (!/^(git\+|git:|file:|https?:)/.test(entry.version)) {
        out.push({ name, version: entry.version, dev: entry.dev === true, location, line: null, ...registry(entry.resolved), specs: [] });
      }
      if (isRecord(entry.dependencies)) stack.push({ deps: entry.dependencies, prefix: `${location}/` });
    }
  }
  return out;
}

/** Split `name@range` (the name may itself start with `@`). */
function splitSpec(spec: string): { name: string; range: string } | null {
  const at = spec.indexOf("@", 1);
  if (at <= 0) return null;
  return { name: spec.slice(0, at), range: spec.slice(at + 1) };
}

/**
 * yarn.lock, both classic (v1) and Berry (v2+) formats. Classic entries record
 * the tarball URL (`resolved`), which names the registry; Berry entries do not
 * (the registry is configured in `.yarnrc.yml`).
 */
export function parseYarnLock(text: string): LockedPackage[] {
  const out: LockedPackage[] = [];
  const lines = text.split(/\r?\n/);
  let current: { specs: string[]; line: number; version?: string; resolved?: string } | null = null;
  const flush = () => {
    if (!current?.version) return;
    const first = splitSpec(current.specs[0] ?? "");
    if (!first) return;
    const ranges = current.specs.map((s) => splitSpec(s)?.range ?? "");
    // Berry prefixes ranges with the protocol (npm:^1.0.0); patch/portal/link/git are not registry packages.
    const registry = ranges.every((r) => !/^(git|github|file|link|portal|patch|workspace|exec)[:+]/.test(r) && !/^https?:/.test(r));
    if (!registry) return;
    const resolved = current.resolved && /^https?:/.test(current.resolved) ? current.resolved : null;
    out.push({
      name: first.name,
      version: current.version,
      dev: false,
      location: null,
      line: current.line,
      publicRegistry: resolved ? isPublicNpmRegistry(resolved) : true,
      registryRecorded: resolved !== null,
      specs: current.specs.map((s) => s.replace(/@npm:/, "@")),
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line) && line.trimEnd().endsWith(":")) {
      flush();
      const header = line.trimEnd().slice(0, -1);
      if (header === "__metadata") {
        current = null;
        continue;
      }
      const specs = header
        .split(/,\s*/)
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
      current = { specs, line: i + 1 };
      continue;
    }
    if (!current) continue;
    const version = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (version) current.version ??= version[1]!;
    const resolved = /^\s+resolved\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (resolved) current.resolved = resolved[1]!;
  }
  flush();
  return out;
}

/**
 * bun.lock (Bun ≥ 1.2 text lockfile, JSONC). `packages` maps an install path
 * (`lodash`, `parent/lodash`) to `[ "name@version", registry, info, integrity ]`;
 * an empty registry means the configured default registry (not recorded here).
 */
export function parseBunLock(text: string): LockedPackage[] {
  const lock = parseJson(stripJsonc(text));
  if (!lock || !isRecord(lock.packages)) return [];
  const lines = text.split(/\r?\n/);
  const keyLines = new Map<string, number>();
  lines.forEach((l, i) => {
    const m = /^\s*"((?:[^"\\]|\\.)+)"\s*:\s*\[/.exec(l);
    if (m && !keyLines.has(m[1]!)) keyLines.set(m[1]!, i + 1);
  });
  const out: LockedPackage[] = [];
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    const spec = splitSpec(entry[0]);
    // Workspace, git, file and tarball entries carry a protocol instead of a version.
    if (!spec || !/^\d/.test(spec.range)) continue;
    const registry = typeof entry[1] === "string" ? entry[1] : "";
    out.push({
      name: spec.name,
      version: spec.range,
      dev: false,
      location,
      line: keyLines.get(location) ?? null,
      publicRegistry: registry === "" || isPublicNpmRegistry(registry),
      registryRecorded: registry !== "",
      specs: [],
    });
  }
  return out;
}

/**
 * pnpm-lock.yaml (lockfile v5–v9). Reads the `packages:` keys for every locked
 * package and the `importers:` section for direct dependency versions.
 */
export function parsePnpmLock(text: string): { packages: LockedPackage[]; importers: Map<string, Map<string, string>> } {
  const lines = text.split(/\r?\n/);
  const packages: LockedPackage[] = [];
  const importers = new Map<string, Map<string, string>>();
  const seen = new Set<string>();
  let section = "";
  let importer: string | null = null;
  let depName: string | null = null;
  let pkg: LockedPackage | null = null;
  const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, "");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      section = line.replace(/:.*$/, "").trim();
      importer = null;
      continue;
    }
    if (section === "importers") {
      if (indent === 2) {
        importer = unquote(line.trim().replace(/:$/, ""));
        importers.set(importer, new Map());
      } else if (indent === 6 && importer !== null) {
        const m = /^\s+(['"]?[^'":\s][^'":]*['"]?):\s*(.*)$/.exec(line);
        if (m) {
          depName = unquote(m[1]!);
          // lockfile v5: `name: 1.2.3` directly under dependencies.
          if (m[2] && !m[2].startsWith("{")) importers.get(importer)!.set(depName, unquote(m[2]).replace(/\(.*$/, ""));
        }
      } else if (indent === 8 && importer !== null && depName) {
        const m = /^\s+version:\s*(.+)$/.exec(line);
        if (m) importers.get(importer)!.set(depName, unquote(m[1]!).replace(/\(.*$/, ""));
      }
      continue;
    }
    if ((section === "dependencies" || section === "devDependencies" || section === "optionalDependencies") && indent === 2) {
      // lockfile v5 single-project layout: top-level `dependencies:` holds direct versions.
      const m = /^\s+(['"]?[^'":\s][^'":]*['"]?):\s*(\S.*)$/.exec(line);
      if (m) {
        if (!importers.has(".")) importers.set(".", new Map());
        importers.get(".")!.set(unquote(m[1]!), unquote(m[2]!).replace(/_.*$|\(.*$/, ""));
      }
      continue;
    }
    if (section === "packages" && indent === 2) {
      // v9: `lodash@4.17.21:`  v6: `/lodash@4.17.21:`  v5: `/lodash/4.17.21:`  (peer suffixes in parentheses or after `_`).
      const key = unquote(line.trim().replace(/:$/, "")).replace(/^\//, "");
      let name: string | null = null;
      let version: string | null = null;
      const at = splitSpec(key);
      if (at && /^\d/.test(at.range)) {
        name = at.name;
        version = at.range.replace(/\(.*$/, "");
      } else {
        const slash = /^(@[^/]+\/[^/]+|[^/@]+)\/(\d[^_/]*)/.exec(key);
        if (slash) {
          name = slash[1]!;
          version = slash[2]!;
        }
      }
      pkg = null;
      if (name && version && !seen.has(`${name}@${version}`)) {
        seen.add(`${name}@${version}`);
        pkg = { name, version, dev: false, location: null, line: i + 1, publicRegistry: true, registryRecorded: false, specs: [] };
        packages.push(pkg);
      }
      continue;
    }
    if (section !== "packages" || !pkg) continue;
    if (indent === 4 && /^\s+dev:\s*true\s*$/.test(line)) pkg.dev = true;
    // pnpm records a tarball URL only for packages that did not come from the default registry:
    // `resolution: {integrity: …, tarball: https://…}` or a nested `tarball:` line.
    const tarball = indent === 4 || indent === 6 ? /\btarball:\s*([^,}\s]+)/.exec(line) : null;
    if (tarball) {
      const url = unquote(tarball[1]!);
      pkg.registryRecorded = true;
      pkg.publicRegistry = /^https?:/.test(url) && isPublicNpmRegistry(url);
    }
  }
  return { packages, importers };
}
