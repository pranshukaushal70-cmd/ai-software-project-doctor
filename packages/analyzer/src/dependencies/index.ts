import { readFile } from "node:fs/promises";
import type { Severity } from "@pd/shared/constants";
import { fingerprint, redactSecrets, type CodeFinding } from "../metrics";
import type { ScannedFile } from "../scanner";
import { downgrade, severityRank } from "../security/types";
import { ANALYZER_VERSION } from "../version";
import { parseCargoLock, parseCargoToml, parseGoMod } from "./go-cargo";
import { parseGradle, parsePom } from "./jvm";
import {
  isPublicNpmRegistry,
  packageJsonName,
  parseBunLock,
  parseNpmRegistryConfig,
  parsePackageJson,
  parsePackageLock,
  parsePnpmLock,
  parseYarnLock,
  type LockedPackage,
  type NpmRegistryConfig,
} from "./npm";
import { fixedVersionFor, lookupVulnerabilities, OSV_DATA_SOURCE, queryKey, type OsvAdvisory, type OsvLookup, type OsvOptions } from "./osv";
import { normalizePyName, parsePipfileLock, parsePythonLock, parseRequirementsTxt, parsePyprojectOrPipfile } from "./python";
import { DEPENDENCY_RULES, type DependencyRuleKey } from "./rules";
import { baseOf, dirOf, joinPath, type DependencyRecord, type Ecosystem, type ParsedManifest } from "./types";

export const DEPENDENCY_ANALYZER_ID = "dependencies";

export interface DependencyFinding extends Omit<CodeFinding, "category" | "line" | "endLine"> {
  category: "DEPENDENCY";
  line: number | null;
  endLine: number | null;
}

export interface AnalyzedDependency extends DependencyRecord {
  /** OSV advisory ids affecting `resolvedVersion`. */
  vulnIds: string[];
  /** Where vulnerability data came from, when the version was checked. */
  dataSource: string | null;
  unusedCandidate: boolean;
}

export interface VulnerabilityScanInfo {
  status: "completed" | "partial" | "failed" | "disabled" | "skipped";
  source: string;
  /** Unique package versions sent to OSV.dev. */
  queried: number;
  /** Dependencies not checked: no exact version known, non-registry source, or a private registry. */
  notChecked: number;
  error: string | null;
  durationMs: number;
}

export interface DependencySummary {
  analyzer: string;
  analyzerVersion: string;
  manifests: Array<{ path: string; ecosystem: Ecosystem; kind: "manifest" | "lockfile"; dependencies: number }>;
  totals: {
    dependencies: number;
    direct: number;
    transitive: number;
    dev: number;
    /** Dependencies with an exact version (from a lockfile or pin). */
    resolved: number;
    vulnerable: number;
    vulnerableDirect: number;
    /** Unique advisories affecting the repository. */
    advisories: number;
    bySeverity: Record<Severity, number>;
    unpinned: number;
    nonRegistry: number;
    unusedCandidates: number;
  };
  byEcosystem: Array<{ ecosystem: Ecosystem; dependencies: number; direct: number; vulnerable: number }>;
  vulnerabilityScan: VulnerabilityScanInfo;
  /** Vulnerable packages, most severe first (at most 100). */
  vulnerable: Array<{
    ecosystem: Ecosystem;
    name: string;
    version: string;
    direct: boolean;
    dev: boolean;
    manifestPath: string;
    severity: Severity;
    fixedVersion: string | null;
    advisories: Array<Pick<OsvAdvisory, "id" | "aliases" | "summary" | "severity" | "score" | "url">>;
  }>;
  unusedCandidates: Array<{ name: string; manifestPath: string }>;
  dependencies: { total: number; stored: number; truncated: boolean };
  findings: { total: number; stored: number; truncated: boolean; bySeverity: Record<Severity, number>; byType: Record<string, number> };
  errors: number;
  durationMs: number;
}

export interface DependencyAnalysis {
  dependencies: AnalyzedDependency[];
  findings: DependencyFinding[];
  summary: DependencySummary;
}

export interface AnalyzeDependenciesOptions {
  /** Enables the OSV.dev lookup; without it vulnerability data is reported as disabled. */
  osv?: OsvOptions;
  /** Imports per analysed file (from code metrics), used to spot npm dependencies that are never imported. */
  imports?: ReadonlyArray<{ path: string; language: string; imports: readonly string[] }>;
  /** Lockfiles are data, not code, and are often larger than the source size limit. */
  maxManifestBytes?: number;
  maxDependencies?: number;
  maxFindings?: number;
}

const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
const NPM_LOCKS = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];
const PY_LOCKS = ["poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock"];
/** Packages commonly required without being imported (runtime peers, compiler helpers). */
const IMPLICIT_NPM = new Set(["react-dom", "typescript", "tslib", "@babel/runtime", "core-js", "regenerator-runtime", "@swc/helpers", "next", "server-only", "client-only"]);

const isManifest = (base: string) =>
  base === "package.json" ||
  NPM_LOCKS.includes(base) ||
  PY_LOCKS.includes(base) ||
  /^requirements[\w.-]*\.txt$/.test(base) ||
  base === "pyproject.toml" ||
  base === "Pipfile" ||
  base === "pom.xml" ||
  /^build\.gradle(\.kts)?$/.test(base) ||
  base === "go.mod" ||
  base === "Cargo.toml" ||
  base === "Cargo.lock";

/** Remove credentials embedded in URLs (`https://user:token@host/…`) and anything that looks like a secret. */
export function redactSpec(spec: string): string {
  return redactSecrets(spec.replace(/\/\/[^/@\s]+@/g, "//<redacted>@"));
}

/** Nearest directory at or above `dir` for which `has(dir)` is true. */
function nearest(dir: string, has: (d: string) => boolean): string | null {
  let d = dir;
  for (;;) {
    if (has(d)) return d;
    if (!d) return null;
    d = dirOf(d);
  }
}

/** Bare import specifier → npm package name (`@scope/pkg/sub` → `@scope/pkg`), or null for relative/builtin/URL imports. */
export function npmPackageOf(spec: string): string | null {
  if (!spec || /^[./]|^[a-z][a-z0-9+.-]*:/i.test(spec)) return null;
  const parts = spec.split("/");
  if (spec.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  return parts[0]!;
}

function isUnpinned(dep: DependencyRecord): boolean {
  if (dep.source !== "registry" || !dep.direct || dep.resolvedVersion) return false;
  const s = (dep.versionSpec ?? "").trim();
  switch (dep.ecosystem) {
    case "npm":
      return s === "" || s === "*" || s === "latest" || s === "x";
    case "PyPI":
      return s === "" || s === "*";
    case "Maven":
      return s === "" || /^(LATEST|RELEASE|\+|latest\.\w+)$/i.test(s) || s.endsWith("+");
    case "crates.io":
      return s === "*";
    default:
      return false;
  }
}

/**
 * Deterministic dependency analysis: parses manifests and lockfiles (npm,
 * PyPI, Maven/Gradle, Go, Cargo), resolves exact versions where a lockfile or
 * pin allows, and checks them against OSV.dev when a fetch function is given.
 */
export async function analyzeDependencies(files: readonly ScannedFile[], opts: AnalyzeDependenciesOptions = {}): Promise<DependencyAnalysis> {
  const started = performance.now();
  const maxBytes = opts.maxManifestBytes ?? 20 * 1024 * 1024;
  let errors = 0;

  const manifestFiles = files.filter((f) => isManifest(baseOf(f.path)) && f.kind !== "BINARY" && f.size <= maxBytes);
  const byPath = new Map(manifestFiles.map((f) => [f.path, f]));
  const texts = new Map<string, string>();
  const read = async (path: string): Promise<string | null> => {
    if (texts.has(path)) return texts.get(path)!;
    const f = byPath.get(path);
    if (!f) return null;
    try {
      const t = await readFile(f.absPath, "utf8");
      texts.set(path, t);
      return t;
    } catch {
      errors++;
      return null;
    }
  };
  const inDir = (dir: string, base: string) => byPath.has(joinPath(dir, base));
  // npm-family lockfiles count as present even when unreadable (bun.lockb is binary), so they are never reported missing.
  const npmLockPaths = new Set(files.filter((f) => NPM_LOCKS.includes(baseOf(f.path))).map((f) => f.path));
  const hasNpmLock = (dir: string, base: string) => npmLockPaths.has(joinPath(dir, base));
  const parsed: ParsedManifest[] = [];
  const findings: Array<{ rule: DependencyRuleKey; path: string; line: number | null; severity: Severity; evidence: string; key: string; recommendation?: string; data?: Record<string, unknown> }> = [];

  // ---------------------------------------------------------------- npm
  const packageJsons = manifestFiles.filter((f) => baseOf(f.path) === "package.json").map((f) => f.path).sort();
  const workspaceNames = new Set<string>();
  for (const p of packageJsons) {
    const name = packageJsonName((await read(p)) ?? "");
    if (name) workspaceNames.add(name);
  }
  // Registry settings committed to the repository. Only registry lines are parsed; tokens in these files are never read out.
  const registryConfigs = new Map<string, NpmRegistryConfig[]>();
  for (const f of files) {
    const base = baseOf(f.path);
    if ((base !== ".npmrc" && base !== ".yarnrc.yml") || f.kind === "BINARY" || f.size > 64 * 1024) continue;
    try {
      const config = parseNpmRegistryConfig(base, await readFile(f.absPath, "utf8"));
      registryConfigs.set(dirOf(f.path), [...(registryConfigs.get(dirOf(f.path)) ?? []), config]);
    } catch {
      errors++;
    }
  }
  /**
   * Whether a package installed in `dir` comes from a public registry, for lockfile
   * entries that do not record their registry. Conservative: private as soon as any
   * config at or above `dir` points the package's scope, or the default registry,
   * elsewhere (including values taken from environment variables).
   */
  const npmPublic = (dir: string, name: string): boolean => {
    const scope = name.startsWith("@") ? name.split("/")[0]! : null;
    for (let d: string | null = dir; d !== null; d = d ? dirOf(d) : null) {
      for (const c of registryConfigs.get(d) ?? []) {
        const url = scope && c.scopes.has(scope) ? c.scopes.get(scope)! : c.registry;
        if (url !== null && !isPublicNpmRegistry(url)) return false;
      }
    }
    return true;
  };

  const lockCache = new Map<string, { packages: LockedPackage[]; importers?: Map<string, Map<string, string>>; kind: string } | null>();
  const loadLock = async (dir: string) => {
    const base = NPM_LOCKS.find((b) => hasNpmLock(dir, b))!;
    const path = joinPath(dir, base);
    if (lockCache.has(path)) return { path, lock: lockCache.get(path)! };
    const text = base === "bun.lockb" ? null : await read(path);
    let lock: { packages: LockedPackage[]; importers?: Map<string, Map<string, string>>; kind: string } | null = null;
    if (text !== null) {
      if (base === "package-lock.json" || base === "npm-shrinkwrap.json") lock = { packages: parsePackageLock(text), kind: base };
      else if (base === "yarn.lock") lock = { packages: parseYarnLock(text), kind: base };
      else if (base === "pnpm-lock.yaml") lock = { ...parsePnpmLock(text), kind: base };
      else if (base === "bun.lock") lock = { packages: parseBunLock(text), kind: base };
    }
    for (const l of lock?.packages ?? []) if (!l.registryRecorded) l.publicRegistry = npmPublic(dir, l.name);
    lockCache.set(path, lock);
    return { path, lock };
  };
  const claimed = new Map<string, Set<LockedPackage>>();

  for (const p of packageJsons) {
    const text = await read(p);
    const manifest = text ? parsePackageJson(p, text) : null;
    if (!manifest) continue;
    parsed.push(manifest);
    const dir = dirOf(p);
    const manifestName = packageJsonName(text ?? "");
    for (const d of manifest.dependencies) if (workspaceNames.has(d.name) && d.source === "registry") d.source = "workspace";
    const registryDeps = manifest.dependencies.filter((d) => d.source === "registry");
    // Until a lockfile entry says otherwise, a package comes from the registry configured for this directory.
    for (const d of registryDeps) d.publicRegistry = npmPublic(dir, d.name);
    const lockDir = nearest(dir, (d) => NPM_LOCKS.some((b) => hasNpmLock(d, b)));
    if (lockDir === null) {
      if (registryDeps.length > 0) {
        const prod = registryDeps.filter((d) => !d.dev).length;
        findings.push({
          rule: "missingLockfile",
          path: p,
          line: null,
          severity: prod > 0 ? "MEDIUM" : "LOW",
          evidence: `\`${p}\` declares ${registryDeps.length} registry ${registryDeps.length === 1 ? "dependency" : "dependencies"} (${prod} runtime) but no package-lock.json, yarn.lock, pnpm-lock.yaml or bun.lock was found in its directory or any parent directory.`,
          key: "npm",
        });
      }
      continue;
    }
    const { path: lockPath, lock } = await loadLock(lockDir);
    if (!lock) continue;
    const used = claimed.get(lockPath) ?? new Set<LockedPackage>();
    claimed.set(lockPath, used);
    const rel = lockDir ? dir.slice(lockDir.length + 1) : dir;
    const byLocation = new Map(lock.packages.filter((l) => l.location).map((l) => [l.location!, l]));
    const byName = new Map<string, LockedPackage[]>();
    for (const l of lock.packages) byName.set(l.name, [...(byName.get(l.name) ?? []), l]);
    for (const d of registryDeps) {
      let hit: LockedPackage | undefined;
      if (lock.kind === "package-lock.json" || lock.kind === "npm-shrinkwrap.json") {
        hit = (rel ? byLocation.get(`${rel}/node_modules/${d.name}`) : undefined) ?? byLocation.get(`node_modules/${d.name}`);
      } else if (lock.kind === "bun.lock") {
        // Bun keys a package's own nested install as `<package name>/<dep>`, hoisted installs by the dependency name.
        hit = (manifestName ? byLocation.get(`${manifestName}/${d.name}`) : undefined) ?? byLocation.get(d.name);
      } else if (lock.kind === "yarn.lock") {
        const candidates = byName.get(d.name) ?? [];
        hit = candidates.find((l) => l.specs.includes(`${d.name}@${d.versionSpec}`)) ?? (candidates.length === 1 ? candidates[0] : undefined);
      } else if (lock.importers) {
        const version = lock.importers.get(rel || ".")?.get(d.name);
        hit = version ? (byName.get(d.name) ?? []).find((l) => l.version === version) : undefined;
        if (!hit && version && /^\d/.test(version)) d.resolvedVersion = version;
      }
      if (hit) {
        d.resolvedVersion = hit.version;
        d.publicRegistry = hit.publicRegistry;
        used.add(hit);
      }
    }
  }
  for (const [lockPath, lock] of lockCache) {
    if (!lock) continue;
    const used = claimed.get(lockPath) ?? new Set();
    const seen = new Set<string>();
    const deps: DependencyRecord[] = [];
    for (const l of lock.packages) {
      const id = `${l.name}@${l.version}`;
      if (used.has(l) || seen.has(id) || workspaceNames.has(l.name)) continue;
      seen.add(id);
      deps.push({
        ecosystem: "npm",
        name: l.name,
        versionSpec: l.version,
        resolvedVersion: l.version,
        direct: false,
        dev: l.dev,
        manifestPath: lockPath,
        line: l.line,
        source: "registry",
        publicRegistry: l.publicRegistry,
      });
    }
    parsed.push({ path: lockPath, ecosystem: "npm", kind: "lockfile", dependencies: deps });
  }

  // ---------------------------------------------------------------- Python
  const pyManifests = manifestFiles
    .filter((f) => /^requirements[\w.-]*\.txt$/.test(baseOf(f.path)) || baseOf(f.path) === "pyproject.toml" || baseOf(f.path) === "Pipfile")
    .map((f) => f.path)
    .sort();
  const pyLockCache = new Map<string, Array<{ name: string; version: string; line: number | null; dev: boolean }>>();
  const pyDeclared = new Map<string, Set<string>>();
  for (const p of pyManifests) {
    const text = await read(p);
    if (text === null) continue;
    const base = baseOf(p);
    const manifest = base.endsWith(".txt") ? parseRequirementsTxt(p, text) : parsePyprojectOrPipfile(p, text);
    if (base === "pyproject.toml" && manifest.dependencies.length === 0) continue;
    parsed.push(manifest);
    const dir = dirOf(p);
    // Pipfile pairs with Pipfile.lock; pyproject with poetry/uv/pdm locks; requirements files are their own pins.
    const lockNames = base === "Pipfile" ? ["Pipfile.lock"] : base === "pyproject.toml" ? ["poetry.lock", "uv.lock", "pdm.lock"] : [];
    const lockDir = lockNames.length ? nearest(dir, (d) => lockNames.some((b) => inDir(d, b))) : null;
    if (lockDir === null) {
      if (base === "Pipfile" && manifest.dependencies.some((d) => d.source === "registry")) {
        findings.push({
          rule: "missingLockfile",
          path: p,
          line: null,
          severity: "LOW",
          evidence: `\`${p}\` declares ${manifest.dependencies.length} packages but no Pipfile.lock was found, so installs are not reproducible.`,
          key: "pipenv",
        });
      }
      continue;
    }
    const lockPath = joinPath(lockDir, lockNames.find((b) => inDir(lockDir, b))!);
    if (!pyLockCache.has(lockPath)) {
      const lockText = await read(lockPath);
      pyLockCache.set(lockPath, lockText === null ? [] : baseOf(lockPath) === "Pipfile.lock" ? parsePipfileLock(lockText) : parsePythonLock(lockText));
    }
    const lock = pyLockCache.get(lockPath)!;
    const declared = pyDeclared.get(lockPath) ?? new Set<string>();
    pyDeclared.set(lockPath, declared);
    for (const d of manifest.dependencies) {
      declared.add(d.name);
      if (d.source !== "registry" || d.resolvedVersion) continue;
      const hit = lock.find((l) => l.name === normalizePyName(d.name));
      if (hit) d.resolvedVersion = hit.version;
    }
  }
  for (const [lockPath, lock] of pyLockCache) {
    const declared = pyDeclared.get(lockPath) ?? new Set();
    const deps: DependencyRecord[] = lock
      .filter((l) => !declared.has(l.name))
      .map((l) => ({
        ecosystem: "PyPI",
        name: l.name,
        versionSpec: `==${l.version}`,
        resolvedVersion: l.version,
        direct: false,
        dev: l.dev,
        manifestPath: lockPath,
        line: l.line,
        source: "registry",
        publicRegistry: true,
      }));
    parsed.push({ path: lockPath, ecosystem: "PyPI", kind: "lockfile", dependencies: deps });
  }

  // ---------------------------------------------------------------- Maven / Gradle / Go
  for (const f of manifestFiles) {
    const base = baseOf(f.path);
    if (base !== "pom.xml" && !/^build\.gradle(\.kts)?$/.test(base) && base !== "go.mod") continue;
    const text = await read(f.path);
    if (text === null) continue;
    parsed.push(base === "pom.xml" ? parsePom(f.path, text) : base === "go.mod" ? parseGoMod(f.path, text) : parseGradle(f.path, text));
  }

  // ---------------------------------------------------------------- Cargo
  const cargoLocks = new Map<string, ReturnType<typeof parseCargoLock>>();
  const cargoDeclared = new Map<string, Set<string>>();
  for (const f of manifestFiles.filter((m) => baseOf(m.path) === "Cargo.toml").sort((a, b) => a.path.localeCompare(b.path))) {
    const text = await read(f.path);
    if (text === null) continue;
    const manifest = parseCargoToml(f.path, text);
    parsed.push(manifest);
    const lockDir = nearest(dirOf(f.path), (d) => inDir(d, "Cargo.lock"));
    if (lockDir === null) continue;
    const lockPath = joinPath(lockDir, "Cargo.lock");
    if (!cargoLocks.has(lockPath)) cargoLocks.set(lockPath, parseCargoLock((await read(lockPath)) ?? ""));
    const lock = cargoLocks.get(lockPath)!;
    const declared = cargoDeclared.get(lockPath) ?? new Set<string>();
    cargoDeclared.set(lockPath, declared);
    for (const d of manifest.dependencies) {
      declared.add(d.name);
      if (d.source !== "registry" && d.source !== "workspace") continue;
      const candidates = lock.filter((l) => l.name === d.name);
      if (candidates.length === 0) continue;
      const pick = candidates.length === 1 ? candidates[0]! : [...candidates].sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0]!;
      d.resolvedVersion = pick.version;
      d.publicRegistry = pick.publicRegistry;
      d.source = "registry";
    }
  }
  for (const [lockPath, lock] of cargoLocks) {
    const declared = cargoDeclared.get(lockPath) ?? new Set();
    parsed.push({
      path: lockPath,
      ecosystem: "crates.io",
      kind: "lockfile",
      dependencies: lock
        .filter((l) => !declared.has(l.name))
        .map((l) => ({
          ecosystem: "crates.io",
          name: l.name,
          versionSpec: l.version,
          resolvedVersion: l.version,
          direct: false,
          dev: false,
          manifestPath: lockPath,
          line: l.line,
          source: "registry",
          publicRegistry: l.publicRegistry,
        })),
    });
  }

  // ---------------------------------------------------------------- vulnerabilities
  const all = parsed.flatMap((m) => m.dependencies);
  for (const d of all) if (d.versionSpec) d.versionSpec = redactSpec(d.versionSpec).slice(0, 200);
  const checkable = (d: DependencyRecord) => d.source === "registry" && d.publicRegistry && !!d.resolvedVersion;
  const queries = all.filter(checkable).map((d) => ({ ecosystem: d.ecosystem, name: d.name, version: d.resolvedVersion! }));
  let lookup: OsvLookup | null = null;
  let scan: VulnerabilityScanInfo;
  const notChecked = all.length - all.filter(checkable).length;
  if (!opts.osv) {
    scan = { status: "disabled", source: OSV_DATA_SOURCE, queried: 0, notChecked: all.length, error: null, durationMs: 0 };
  } else if (queries.length === 0) {
    scan = { status: "skipped", source: OSV_DATA_SOURCE, queried: 0, notChecked, error: null, durationMs: 0 };
  } else {
    lookup = await lookupVulnerabilities(queries, opts.osv);
    scan = { status: lookup.status, source: OSV_DATA_SOURCE, queried: lookup.queried, notChecked, error: lookup.error, durationMs: lookup.durationMs };
  }

  const analyzed: AnalyzedDependency[] = all.map((d) => {
    const checked = lookup !== null && lookup.status !== "failed" && checkable(d);
    const vulnIds = checked ? (lookup!.vulnsByPackage.get(queryKey({ ecosystem: d.ecosystem, name: d.name, version: d.resolvedVersion! })) ?? []) : [];
    return { ...d, vulnIds, dataSource: checked ? OSV_DATA_SOURCE : null, unusedCandidate: false };
  });

  const vulnerable: DependencySummary["vulnerable"] = [];
  for (const d of analyzed) {
    if (d.vulnIds.length === 0) continue;
    const advisories = d.vulnIds.map((id) => lookup!.advisories.get(id)).filter((a): a is OsvAdvisory => !!a);
    const worst = advisories.reduce<Severity>((w, a) => (severityRank(a.severity) < severityRank(w) ? a.severity : w), "INFO");
    const severity = d.dev ? downgrade(worst) : worst;
    const fixed = fixedVersionFor(advisories, d.ecosystem, d.name, d.resolvedVersion!);
    const where = d.direct ? `direct ${d.dev ? "development " : ""}dependency in \`${d.manifestPath}\`` : `transitive ${d.dev ? "development " : ""}dependency locked in \`${d.manifestPath}\``;
    const listed = advisories
      .slice(0, 5)
      .map((a) => `${a.id}${a.aliases.find((x) => x.startsWith("CVE-")) ? ` / ${a.aliases.find((x) => x.startsWith("CVE-"))}` : ""} (${a.severity}${a.score !== null ? `, CVSS ${a.score}` : ""}): ${a.summary}`)
      .join("; ");
    const more = advisories.length > 5 ? `; and ${advisories.length - 5} more` : "";
    findings.push({
      rule: "vulnerable",
      path: d.manifestPath,
      line: d.line,
      severity,
      evidence:
        `\`${d.name}@${d.resolvedVersion}\` (${d.ecosystem}, ${where}) is affected by ${advisories.length} known ${advisories.length === 1 ? "vulnerability" : "vulnerabilities"}: ${listed}${more}.` +
        (d.dev && severity !== worst ? " Severity is lowered one level because it is a development-only dependency." : ""),
      key: `${d.ecosystem}:${d.name}`,
      recommendation: fixed
        ? `Upgrade ${d.name} to ${fixed} or later${d.direct ? "" : ": it is a transitive dependency, so update the package that requires it or add an override/resolution for it"}.`
        : `No release fixes every listed advisory yet. Check whether the vulnerable functionality is reachable, follow the advisories for workarounds, and consider an alternative to ${d.name}.`,
      data: {
        ecosystem: d.ecosystem,
        package: d.name,
        version: d.resolvedVersion,
        direct: d.direct,
        dev: d.dev,
        fixedVersion: fixed,
        advisories: advisories.map((a) => ({ id: a.id, aliases: a.aliases, severity: a.severity, score: a.score, summary: a.summary, url: a.url })),
      },
    });
    vulnerable.push({
      ecosystem: d.ecosystem,
      name: d.name,
      version: d.resolvedVersion!,
      direct: d.direct,
      dev: d.dev,
      manifestPath: d.manifestPath,
      severity,
      fixedVersion: fixed,
      advisories: advisories.map(({ id, aliases, summary, severity, score, url }) => ({ id, aliases, summary, severity, score, url })),
    });
  }

  // ---------------------------------------------------------------- hygiene
  for (const d of analyzed) {
    if (isUnpinned(d)) {
      findings.push({
        rule: "unpinned",
        path: d.manifestPath,
        line: d.line,
        severity: d.dev ? "INFO" : "LOW",
        evidence: `\`${d.name}\` is declared with the constraint \`${d.versionSpec || "(none)"}\` and no lockfile pins it, so any future version can be installed.`,
        key: `${d.ecosystem}:${d.name}`,
      });
    }
    if (d.direct && (d.source === "git" || d.source === "url")) {
      findings.push({
        rule: "nonRegistry",
        path: d.manifestPath,
        line: d.line,
        severity: "LOW",
        evidence: `\`${d.name}\` is installed from ${d.source === "git" ? "a git repository" : "a URL"} (\`${d.versionSpec}\`) instead of the ${d.ecosystem} registry, so it is not covered by the vulnerability check.`,
        key: `${d.ecosystem}:${d.name}`,
      });
    }
  }

  // Runtime npm dependencies that no analysed file in the package imports.
  if (opts.imports) {
    const pkgDirs = packageJsons.map(dirOf);
    const owner = (path: string) => pkgDirs.filter((d) => d === "" || path === d || path.startsWith(`${d}/`)).sort((a, b) => b.length - a.length)[0];
    const importedBy = new Map<string, Set<string>>();
    const filesBy = new Map<string, number>();
    for (const f of opts.imports) {
      if (f.language !== "javascript" && f.language !== "typescript") continue;
      const dir = owner(f.path);
      if (dir === undefined) continue;
      filesBy.set(dir, (filesBy.get(dir) ?? 0) + 1);
      const set = importedBy.get(dir) ?? new Set<string>();
      for (const spec of f.imports) {
        const pkg = npmPackageOf(spec);
        if (pkg) set.add(pkg);
      }
      importedBy.set(dir, set);
    }
    // Config files (next.config.js, .babelrc, tsconfig.json …) load packages by name without importing them.
    const configText = new Map<string, string>();
    for (const f of files) {
      if (f.kind !== "CONFIG" && !/(^|\/)[^/]*\.config\.[cm]?[jt]s$/.test(f.path)) continue;
      // Manifests and lockfiles name every dependency, so they are no evidence that a package is used.
      if (isManifest(baseOf(f.path))) continue;
      if (f.oversized || f.size > 256 * 1024) continue;
      const dir = owner(f.path);
      if (dir === undefined || (dir ? f.path.slice(dir.length + 1) : f.path).includes("/")) continue;
      try {
        configText.set(dir, `${configText.get(dir) ?? ""}\n${await readFile(f.absPath, "utf8")}`);
      } catch {
        // unreadable config: no exemption from it
      }
    }
    for (const p of packageJsons) {
      const dir = dirOf(p);
      const imported = importedBy.get(dir);
      if (!imported || (filesBy.get(dir) ?? 0) === 0) continue;
      let pkg: Record<string, unknown> | null = null;
      try {
        pkg = JSON.parse(texts.get(p) ?? "null") as Record<string, unknown> | null;
      } catch {
        pkg = null;
      }
      const runtime = pkg && typeof pkg.dependencies === "object" && pkg.dependencies ? Object.keys(pkg.dependencies) : [];
      const scripts = JSON.stringify(pkg?.scripts ?? {});
      const config = configText.get(dir) ?? "";
      for (const name of runtime) {
        if (imported.has(name) || IMPLICIT_NPM.has(name) || name.startsWith("@types/") || workspaceNames.has(name)) continue;
        if (scripts.includes(name) || config.includes(name)) continue;
        const dep = analyzed.find((d) => d.manifestPath === p && d.name === name && d.direct);
        if (!dep || dep.source !== "registry") continue;
        dep.unusedCandidate = true;
        findings.push({
          rule: "unused",
          path: p,
          line: dep.line,
          severity: "INFO",
          evidence: `\`${name}\` is a runtime dependency in \`${p}\`, but none of the ${filesBy.get(dir)} JavaScript/TypeScript files in this package import or require it, and it is not referenced by package scripts or config files.`,
          key: `npm:${name}`,
        });
      }
    }
  }

  // ---------------------------------------------------------------- assemble
  const ordinals = new Map<string, number>();
  const allFindings: DependencyFinding[] = findings.map((f) => {
    const rule = DEPENDENCY_RULES[f.rule];
    const base = `${rule.id}\0${f.path}\0${f.key}`;
    const ordinal = ordinals.get(base) ?? 0;
    ordinals.set(base, ordinal + 1);
    return {
      ruleId: rule.id,
      type: rule.type,
      category: "DEPENDENCY",
      severity: f.severity,
      title: rule.title,
      path: f.path,
      line: f.line,
      endLine: f.line,
      evidence: f.evidence,
      impact: rule.impact,
      recommendation: f.recommendation ?? rule.recommendation,
      fingerprint: fingerprint(rule.id, f.path, ordinal === 0 ? f.key : `${f.key}#${ordinal}`),
      analyzer: DEPENDENCY_ANALYZER_ID,
      analyzerVersion: ANALYZER_VERSION,
      data: f.data ?? null,
    };
  });
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byType: Record<string, number> = {};
  for (const f of allFindings) {
    bySeverity[f.severity]++;
    byType[f.type] = (byType[f.type] ?? 0) + 1;
  }
  const maxFindings = opts.maxFindings ?? 2000;
  const storedFindings = [...allFindings]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0))
    .slice(0, maxFindings);

  const vulnBySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const v of vulnerable) vulnBySeverity[v.severity]++;
  vulnerable.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));

  const maxDeps = opts.maxDependencies ?? 20_000;
  const storedDeps = [...analyzed]
    .sort((a, b) => b.vulnIds.length - a.vulnIds.length || Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name))
    .slice(0, maxDeps);

  const ecosystems = new Map<Ecosystem, { dependencies: number; direct: number; vulnerable: number }>();
  for (const d of analyzed) {
    const e = ecosystems.get(d.ecosystem) ?? { dependencies: 0, direct: 0, vulnerable: 0 };
    e.dependencies++;
    if (d.direct) e.direct++;
    if (d.vulnIds.length) e.vulnerable++;
    ecosystems.set(d.ecosystem, e);
  }

  return {
    dependencies: storedDeps,
    findings: storedFindings,
    summary: {
      analyzer: DEPENDENCY_ANALYZER_ID,
      analyzerVersion: ANALYZER_VERSION,
      manifests: parsed.map((m) => ({ path: m.path, ecosystem: m.ecosystem, kind: m.kind, dependencies: m.dependencies.length })).sort((a, b) => a.path.localeCompare(b.path)),
      totals: {
        dependencies: analyzed.length,
        direct: analyzed.filter((d) => d.direct).length,
        transitive: analyzed.filter((d) => !d.direct).length,
        dev: analyzed.filter((d) => d.dev).length,
        resolved: analyzed.filter((d) => d.resolvedVersion).length,
        vulnerable: vulnerable.length,
        vulnerableDirect: vulnerable.filter((v) => v.direct).length,
        advisories: new Set(vulnerable.flatMap((v) => v.advisories.map((a) => a.id))).size,
        bySeverity: vulnBySeverity,
        unpinned: allFindings.filter((f) => f.type === DEPENDENCY_RULES.unpinned.type).length,
        nonRegistry: allFindings.filter((f) => f.type === DEPENDENCY_RULES.nonRegistry.type).length,
        unusedCandidates: analyzed.filter((d) => d.unusedCandidate).length,
      },
      byEcosystem: [...ecosystems.entries()].map(([ecosystem, e]) => ({ ecosystem, ...e })).sort((a, b) => b.dependencies - a.dependencies),
      vulnerabilityScan: scan,
      vulnerable: vulnerable.slice(0, 100),
      unusedCandidates: analyzed.filter((d) => d.unusedCandidate).slice(0, 50).map((d) => ({ name: d.name, manifestPath: d.manifestPath })),
      dependencies: { total: analyzed.length, stored: storedDeps.length, truncated: analyzed.length > storedDeps.length },
      findings: { total: allFindings.length, stored: storedFindings.length, truncated: allFindings.length > storedFindings.length, bySeverity, byType },
      errors,
      durationMs: Math.round(performance.now() - started),
    },
  };
}

export { DEPENDENCY_RULES } from "./rules";
export { cvss3BaseScore, cvssSeverity } from "./cvss";
export { lookupVulnerabilities, parseAdvisory, compareVersions, fixedVersionFor, OSV_API, OSV_DATA_SOURCE, type OsvOptions, type OsvAdvisory } from "./osv";
export {
  parsePackageJson,
  parsePackageLock,
  parseYarnLock,
  parsePnpmLock,
  parseBunLock,
  parseNpmRegistryConfig,
  isPublicNpmRegistry,
  npmSource,
  exactNpmVersion,
} from "./npm";
export { parseRequirementsTxt, parsePyprojectOrPipfile, parsePythonLock, parsePipfileLock, parseRequirement, exactPyVersion } from "./python";
export { parsePom, parseGradle, exactJvmVersion } from "./jvm";
export { parseGoMod, parseCargoToml, parseCargoLock, exactCargoVersion } from "./go-cargo";
export type { DependencyRecord, Ecosystem, DependencySource, ParsedManifest } from "./types";
