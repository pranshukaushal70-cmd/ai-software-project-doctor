import "server-only";
import type { DependencySummary, Ecosystem } from "@pd/analyzer/dependencies";
import { getPrisma, type Prisma } from "@pd/db";
import { DEPENDENCY_ECOSYSTEMS, type DependenciesQuery } from "@pd/shared";

// The query schema's ecosystem list must stay in step with the analyzer's.
const ECOSYSTEMS: readonly Ecosystem[] = DEPENDENCY_ECOSYSTEMS;

/**
 * The dependency summary stored on Analysis.summary by the worker, or null when
 * the analysis has not finished or predates the dependency analyzer.
 */
export function dependencySummaryOf(summary: unknown): DependencySummary | null {
  if (!summary || typeof summary !== "object") return null;
  const dep = (summary as { dependencies?: unknown }).dependencies;
  return dep && typeof dep === "object" && (dep as { analyzer?: unknown }).analyzer === "dependencies" ? (dep as DependencySummary) : null;
}

type Filters = Omit<DependenciesQuery, "page" | "pageSize" | "sort">;

export function buildDependenciesWhere(analysisId: string, q: Filters): Prisma.DependencyWhereInput {
  return {
    analysisId,
    ...(q.ecosystem?.length ? { ecosystem: { in: q.ecosystem } } : {}),
    ...(q.scope === "direct" ? { direct: true } : q.scope === "transitive" ? { direct: false } : {}),
    ...(q.dev === "exclude" ? { dev: false } : q.dev === "only" ? { dev: true } : {}),
    ...(q.vulnerable === undefined ? {} : { vulnIds: { isEmpty: !q.vulnerable } }),
    ...(q.unused === undefined ? {} : { unusedCandidate: q.unused }),
    ...(q.q ? { name: { contains: q.q, mode: "insensitive" as const } } : {}),
    ...(q.manifest ? { manifestPath: q.manifest } : {}),
  };
}

/** Scope for the ecosystem facet: every filter except the ecosystem itself. */
export function buildEcosystemFacetWhere(analysisId: string, q: Filters): Prisma.DependencyWhereInput {
  return buildDependenciesWhere(analysisId, { ...q, ecosystem: undefined });
}

export const DEPENDENCY_ORDER = {
  name: [{ name: "asc" }, { manifestPath: "asc" }],
  ecosystem: [{ ecosystem: "asc" }, { name: "asc" }, { manifestPath: "asc" }],
  manifest: [{ manifestPath: "asc" }, { name: "asc" }],
} satisfies Record<DependenciesQuery["sort"], Prisma.DependencyOrderByWithRelationInput[]>;

type Vulnerable = DependencySummary["vulnerable"][number];
const vulnKey = (v: { ecosystem: string; name: string; version: string | null; manifestPath: string }) =>
  `${v.ecosystem}\0${v.name}\0${v.version}\0${v.manifestPath}`;

/**
 * Advisory details (severity, fixed version, advisories) for a vulnerable row.
 * They are kept in the analysis summary for the most severe packages only, so
 * rows beyond that list carry their advisory ids without details.
 */
export function vulnerabilityDetails(summary: DependencySummary | null) {
  const byKey = new Map<string, Vulnerable>((summary?.vulnerable ?? []).map((v) => [vulnKey(v), v]));
  return (d: { ecosystem: string; name: string; resolvedVersion: string | null; manifestPath: string; vulnIds: string[] }) => {
    if (d.vulnIds.length === 0) return null;
    const v = byKey.get(vulnKey({ ...d, version: d.resolvedVersion }));
    return v ? { severity: v.severity, fixedVersion: v.fixedVersion, advisories: v.advisories } : null;
  };
}

/** Dependencies of one analysis with filters, pagination and ecosystem facet counts. */
export async function listDependencies(analysisId: string, q: DependenciesQuery, summary: DependencySummary | null) {
  const prisma = getPrisma();
  const where = buildDependenciesWhere(analysisId, q);
  const [total, rows, byEcosystem] = await Promise.all([
    prisma.dependency.count({ where }),
    prisma.dependency.findMany({
      where,
      orderBy: DEPENDENCY_ORDER[q.sort],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: {
        id: true,
        ecosystem: true,
        name: true,
        versionSpec: true,
        resolvedVersion: true,
        direct: true,
        dev: true,
        manifestPath: true,
        vulnIds: true,
        dataSource: true,
        unusedCandidate: true,
      },
    }),
    prisma.dependency.groupBy({ by: ["ecosystem"], where: buildEcosystemFacetWhere(analysisId, q), _count: { _all: true } }),
  ]);
  const details = vulnerabilityDetails(summary);
  return {
    summary,
    dependencies: rows.map((d) => ({ ...d, vulnerability: details(d) })),
    page: q.page,
    pageSize: q.pageSize,
    total,
    facets: {
      ecosystem: byEcosystem
        .map((g) => ({ value: g.ecosystem, count: g._count._all }))
        .sort((a, b) => b.count - a.count || ECOSYSTEMS.indexOf(a.value as Ecosystem) - ECOSYSTEMS.indexOf(b.value as Ecosystem)),
    },
  };
}
