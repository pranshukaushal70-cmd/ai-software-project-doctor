/** OSV.dev ecosystem names, used verbatim in vulnerability queries. */
export type Ecosystem = "npm" | "PyPI" | "Maven" | "Go" | "crates.io";

/** Where a dependency is fetched from. Only registry packages are checked against OSV.dev. */
export type DependencySource = "registry" | "git" | "url" | "path" | "workspace";

/** One declared or locked dependency, before vulnerability data is attached. */
export interface DependencyRecord {
  ecosystem: Ecosystem;
  name: string;
  /** Version constraint as written in the manifest (`^1.2.0`, `>=2`, `*`), or the locked version for lockfile-only entries. */
  versionSpec: string | null;
  /** Exact version: from a lockfile or an exact pin. Only exact versions are queried for vulnerabilities. */
  resolvedVersion: string | null;
  /** Declared in a manifest (as opposed to only appearing in a lockfile). */
  direct: boolean;
  /** Development/test-only dependency. */
  dev: boolean;
  /** Manifest that declares it, or the lockfile for transitive entries. */
  manifestPath: string;
  /** 1-based line of the declaration in `manifestPath`, when known. */
  line: number | null;
  source: DependencySource;
  /**
   * False when the package was resolved from a non-public registry; its name
   * is then never sent to OSV.dev (it could reveal internal package names).
   */
  publicRegistry: boolean;
}

/** A parsed manifest or lockfile. */
export interface ParsedManifest {
  path: string;
  ecosystem: Ecosystem;
  kind: "manifest" | "lockfile";
  dependencies: DependencyRecord[];
}

export const lineOf = (lines: readonly string[], re: RegExp, from = 0): number | null => {
  for (let i = from; i < lines.length; i++) if (re.test(lines[i]!)) return i + 1;
  return null;
};

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const joinPath = (dir: string, file: string) => (dir ? `${dir}/${file}` : file);
