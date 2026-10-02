import "server-only";
import { getPrisma, type Prisma, type Severity } from "@pd/db";
import { SEVERITIES, type FindingsQuery } from "@pd/shared";

type FindingFilters = Omit<FindingsQuery, "page" | "pageSize" | "triage"> & { triage?: FindingsQuery["triage"] };

/**
 * @param triagedFingerprints fingerprints marked Expected/Ignored in this analysis's repository;
 *   only used by the `triage` filter, which defaults to showing everything.
 */
export function buildFindingsWhere(analysisId: string, q: FindingFilters, triagedFingerprints: readonly string[] = []): Prisma.FindingWhereInput {
  return {
    analysisId,
    ...(q.severity?.length ? { severity: { in: q.severity } } : {}),
    ...(q.category?.length ? { category: { in: q.category } } : {}),
    ...(q.type?.length ? { type: { in: q.type } } : {}),
    ...(q.path ? { file: { path: q.path } } : {}),
    ...(q.triage === "untriaged" && triagedFingerprints.length ? { fingerprint: { notIn: [...triagedFingerprints] } } : {}),
    ...(q.triage === "triaged" ? { fingerprint: { in: [...triagedFingerprints] } } : {}),
  };
}

/** Scope for facet counts: the filters that are not themselves facets. */
export function buildFacetWhere(analysisId: string, q: FindingFilters, triagedFingerprints: readonly string[] = []): Prisma.FindingWhereInput {
  return buildFindingsWhere(analysisId, { category: q.category, path: q.path, triage: q.triage }, triagedFingerprints);
}

const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<Severity, number>;

/**
 * Findings for one analysis, most severe first. Postgres sorts enums by
 * declaration order (CRITICAL … INFO), which is the order we want.
 * Facet counts ignore the severity/type filters (so the UI can show totals for
 * every chip) but respect the category/path scope.
 */
export async function listFindings(analysisId: string, repositoryId: string, q: FindingsQuery) {
  const prisma = getPrisma();
  // Triage decisions belong to the repository and match findings by fingerprint.
  const triages = await prisma.findingTriage.findMany({
    where: { repositoryId },
    select: { fingerprint: true, status: true, reason: true, updatedAt: true },
  });
  const triageByFingerprint = new Map(triages.map(({ fingerprint, ...t }) => [fingerprint, t]));
  const triaged = [...triageByFingerprint.keys()];
  const where = buildFindingsWhere(analysisId, q, triaged);
  const facetWhere = buildFacetWhere(analysisId, q, triaged);
  const [total, findings, bySeverity, byType] = await Promise.all([
    prisma.finding.count({ where }),
    prisma.finding.findMany({
      where,
      orderBy: [{ severity: "asc" }, { file: { path: "asc" } }, { line: "asc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: {
        id: true,
        category: true,
        type: true,
        severity: true,
        ruleId: true,
        title: true,
        line: true,
        endLine: true,
        evidence: true,
        impact: true,
        recommendation: true,
        fingerprint: true,
        data: true,
        analyzer: true,
        analyzerVersion: true,
        file: { select: { path: true, language: true } },
      },
    }),
    prisma.finding.groupBy({ by: ["severity"], where: facetWhere, _count: { _all: true } }),
    prisma.finding.groupBy({ by: ["type"], where: facetWhere, _count: { _all: true } }),
  ]);

  return {
    findings: findings.map(({ file, ...f }) => ({
      ...f,
      path: file?.path ?? null,
      language: file?.language ?? null,
      triage: triageByFingerprint.get(f.fingerprint) ?? null,
    })),
    page: q.page,
    pageSize: q.pageSize,
    total,
    facets: {
      severity: bySeverity
        .map((g) => ({ value: g.severity, count: g._count._all }))
        .sort((a, b) => SEVERITY_RANK[a.value] - SEVERITY_RANK[b.value]),
      type: byType.map((g) => ({ value: g.type, count: g._count._all })).sort((a, b) => b.count - a.count),
    },
  };
}
