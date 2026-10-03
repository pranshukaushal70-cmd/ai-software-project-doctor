import type { Prisma } from "@pd/db";
import { AppError, type ReportsQuery } from "@pd/shared";
import { buildReport } from "./build";
import { collectReportInput, type ReportPrisma, type ReportSubject } from "./collect";
import { REPORT_VERSION, type ReportData } from "./types";

/**
 * Report persistence. A report is immutable once stored: generating again creates a
 * new snapshot, unless nothing changed, in which case the existing report (same
 * subject, same fingerprint) is returned. Every read is scoped to the user who owns
 * the repository; other users' reports are "not found".
 */

/** Columns of a report without its snapshot, for lists. */
export const REPORT_SUMMARY_SELECT = {
  id: true,
  type: true,
  status: true,
  outcome: true,
  version: true,
  title: true,
  summary: true,
  errorCount: true,
  warningCount: true,
  repositoryId: true,
  analysisId: true,
  planId: true,
  runId: true,
  generatedAt: true,
} satisfies Prisma.ReportSelect;

export type ReportSummaryRow = Prisma.ReportGetPayload<{ select: typeof REPORT_SUMMARY_SELECT }>;
export type ReportRow = ReportSummaryRow & { data: ReportData };

const subjectKey = (s: ReportSubject) => `${s.type}:${s.id}`;
/** The JSON column holds a snapshot built by buildReport (REPORT_VERSION schema). */
const asRow = <T extends { data: unknown }>(row: T) => row as unknown as Omit<T, "data"> & { data: ReportData };
const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === "P2002";

/** Builds a report for the subject and stores it; returns the existing one when nothing changed. */
export async function generateReport(prisma: ReportPrisma, userId: string, subject: ReportSubject): Promise<{ report: ReportRow; created: boolean }> {
  const { input, refs } = await collectReportInput(prisma, userId, subject);
  const built = buildReport(input);
  const key = subjectKey(subject);
  const select = { ...REPORT_SUMMARY_SELECT, data: true } as const;
  const existing = await prisma.report.findUnique({ where: { subjectKey_fingerprint: { subjectKey: key, fingerprint: built.fingerprint } }, select });
  if (existing) return { report: asRow(existing), created: false };
  try {
    const report = await prisma.report.create({
      data: {
        userId,
        repositoryId: refs.repositoryId,
        analysisId: refs.analysisId,
        planId: refs.planId,
        runId: refs.runId,
        type: built.type,
        subjectKey: key,
        status: built.status,
        outcome: built.outcome,
        version: REPORT_VERSION,
        title: built.title,
        summary: built.summary,
        errorCount: built.errorCount,
        warningCount: built.warningCount,
        fingerprint: built.fingerprint,
        data: built.data as unknown as Prisma.InputJsonValue,
      },
      select,
    });
    return { report: asRow(report), created: true };
  } catch (err) {
    // A concurrent identical generation won the race: return its report.
    if (!isUniqueViolation(err)) throw err;
    const winner = await prisma.report.findUnique({ where: { subjectKey_fingerprint: { subjectKey: key, fingerprint: built.fingerprint } }, select });
    if (!winner) throw err;
    return { report: asRow(winner), created: false };
  }
}

const ownedWhere = (userId: string): Prisma.ReportWhereInput => ({ userId, repository: { userId } });

/** The user's reports, newest first, filtered and paginated. */
export async function listReports(prisma: ReportPrisma, userId: string, q: ReportsQuery) {
  const where: Prisma.ReportWhereInput = {
    ...ownedWhere(userId),
    ...(q.repositoryId ? { repositoryId: q.repositoryId } : {}),
    ...(q.analysisId ? { analysisId: q.analysisId } : {}),
    ...(q.planId ? { planId: q.planId } : {}),
    ...(q.runId ? { runId: q.runId } : {}),
    ...(q.type ? { type: q.type } : {}),
    ...(q.status ? { status: q.status } : {}),
    ...(q.outcome ? { outcome: q.outcome } : {}),
  };
  const [total, items] = await Promise.all([
    prisma.report.count({ where }),
    prisma.report.findMany({
      where,
      orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: { ...REPORT_SUMMARY_SELECT, repository: { select: { name: true, owner: true } } },
    }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize, pages: Math.max(1, Math.ceil(total / q.pageSize)) };
}

/** One report with its snapshot; 404 for anyone but its owner. */
export async function getReport(prisma: ReportPrisma, userId: string, reportId: string): Promise<ReportRow> {
  const report = await prisma.report.findFirst({ where: { id: reportId, ...ownedWhere(userId) }, select: { ...REPORT_SUMMARY_SELECT, data: true } });
  if (!report) throw new AppError("NOT_FOUND", "Report not found");
  return asRow(report);
}

/** The newest report about a subject, or null when none was generated yet. */
export async function latestReport(prisma: ReportPrisma, userId: string, subject: ReportSubject): Promise<ReportRow | null> {
  const report = await prisma.report.findFirst({
    where: { subjectKey: subjectKey(subject), ...ownedWhere(userId) },
    orderBy: [{ generatedAt: "desc" }, { id: "desc" }],
    select: { ...REPORT_SUMMARY_SELECT, data: true },
  });
  return report ? asRow(report) : null;
}
