/**
 * Dependency rule catalogue. Every dependency finding references one of these
 * entries, so its impact and default recommendation are always explainable.
 */
export interface DependencyRuleDefinition {
  id: string;
  /** Short machine-friendly finding type, stored as Finding.type. */
  type: string;
  title: string;
  impact: string;
  recommendation: string;
}

const rule = (r: DependencyRuleDefinition) => r;

export const DEPENDENCY_RULES = {
  vulnerable: rule({
    id: "dependency/known-vulnerability",
    type: "vulnerable-dependency",
    title: "Dependency version with known vulnerabilities",
    impact:
      "The installed version is listed in a public vulnerability database. Published advisories are actively scanned for by attackers, and a vulnerable transitive dependency is as exploitable as a direct one when its code is reachable.",
    recommendation:
      "Upgrade to a fixed version (update the lockfile for transitive dependencies, e.g. npm update / npm audit fix, pip install -U, or an override/resolution). If no fix exists, check whether the vulnerable code path is used and consider an alternative package.",
  }),
  missingLockfile: rule({
    id: "dependency/missing-lockfile",
    type: "missing-lockfile",
    title: "Dependencies are not locked",
    impact:
      "Without a lockfile every install can resolve different versions within the declared ranges, so builds are not reproducible and a compromised or broken release can be picked up silently.",
    recommendation: "Commit the lockfile your package manager produces (package-lock.json, yarn.lock, pnpm-lock.yaml, Pipfile.lock, poetry.lock) and install with the frozen variant in CI (npm ci, pip install --require-hashes, poetry install --sync).",
  }),
  unpinned: rule({
    id: "dependency/unpinned-version",
    type: "unpinned-dependency",
    title: "Dependency accepts any version",
    impact: "A wildcard or `latest` constraint accepts future major versions with breaking changes, and with no lockfile the resolved version changes over time.",
    recommendation: "Declare a bounded version range (e.g. ^1.4.0 or ~=1.4) and commit a lockfile.",
  }),
  nonRegistry: rule({
    id: "dependency/non-registry-source",
    type: "non-registry-dependency",
    title: "Dependency installed from a git repository or URL",
    impact:
      "Git and URL dependencies bypass the registry: they are not covered by vulnerability databases, a branch or tag can be moved to different code, and tarball URLs can change content unless pinned by hash.",
    recommendation: "Prefer a published registry release. Otherwise pin the dependency to a full commit hash (or verify the archive hash) and review updates manually.",
  }),
  unused: rule({
    id: "dependency/unused-candidate",
    type: "unused-dependency",
    title: "Declared dependency is never imported",
    impact: "Unused dependencies increase install size, attack surface and the number of advisories to triage, without adding value.",
    recommendation:
      "Confirm the package is not loaded indirectly (CLI tool, framework plugin, config file, peer requirement) and remove it from the manifest if it is truly unused, or move tooling to devDependencies.",
  }),
} as const;

export type DependencyRuleKey = keyof typeof DEPENDENCY_RULES;
