import "server-only";
import { getPrisma, type Prisma, type Severity } from "@pd/db";
import { SEVERITIES, type FindingsQuery } from "@pd/shared";

export function buildFindingsWhere(analysisId: string, q: Omit<FindingsQuery, "page" | "pageSize">): Prisma.FindingWhereInput {
  return {
    analysisId,
    ...(q.severity?.length ? { severity: { in: q.severity } } : {}),
    ...(q.category?.length ? { category: { in: q.category } } : {}),
    ...(q.type?.length ? { type: { in: q.type } } : {}),
    ...(q.path ? { file: { path: q.path } } : {}),
  };
}

const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])) as Record<Severity, number>;

/**
 * Findings for one analysis, most severe first. Postgres sorts enums by
 * declaration order (CRITICAL … INFO), which is the order we want.
 * Facet counts ignore the severity/type filters so the UI can show totals.
 */
export async function listFindings(analysisId: string, q: FindingsQuery) {
  const prisma = getPrisma();
  const where = buildFindingsWhere(analysisId, q);
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
    prisma.finding.groupBy({ by: ["severity"], where: { analysisId }, _count: { _all: true } }),
    prisma.finding.groupBy({ by: ["type"], where: { analysisId }, _count: { _all: true } }),
  ]);

  return {
    findings: findings.map(({ file, ...f }) => ({ ...f, path: file?.path ?? null, language: file?.language ?? null })),
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
