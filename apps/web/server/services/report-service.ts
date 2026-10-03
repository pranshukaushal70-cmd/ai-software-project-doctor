import "server-only";
import { getPrisma } from "@pd/db";
import { generateReport, getReport, latestReport, listReports, renderMarkdown, type ReportRow } from "@pd/reports";
import type { ReportCreateInput, ReportExportQuery, ReportLatestQuery, ReportsQuery } from "@pd/shared";
import { createLogger } from "@pd/shared/logger";

/**
 * Reports (Phase 9), web side: thin wrappers over @pd/reports, which owns the
 * report model, generation, ownership checks and rendering. Reports are generated
 * from stored data only; nothing here reads a repository or calls a model.
 */

const log = createLogger("reports");

export async function createReport(userId: string, input: ReportCreateInput) {
  const { report, created } = await generateReport(getPrisma(), userId, { type: input.type, id: input.subjectId });
  // Ids, type and result only: never report content.
  log.info({ reportId: report.id, type: report.type, status: report.status, outcome: report.outcome, created }, created ? "report generated" : "report unchanged");
  return { report, created };
}

export const findReports = (userId: string, q: ReportsQuery) => listReports(getPrisma(), userId, q);
export const findReport = (userId: string, id: string) => getReport(getPrisma(), userId, id);
export const findLatestReport = (userId: string, q: ReportLatestQuery) => latestReport(getPrisma(), userId, { type: q.type, id: q.subjectId });

/** The report as a downloadable file: Markdown (escaped) or the JSON snapshot. */
export async function exportReport(userId: string, id: string, q: ReportExportQuery): Promise<{ filename: string; contentType: string; body: string }> {
  const report: ReportRow = await getReport(getPrisma(), userId, id);
  const generatedAt = report.generatedAt.toISOString();
  if (q.format === "json") {
    const { data, ...meta } = report;
    return { filename: `report-${report.id}.json`, contentType: "application/json; charset=utf-8", body: `${JSON.stringify({ ...meta, generatedAt, data }, null, 2)}\n` };
  }
  return { filename: `report-${report.id}.md`, contentType: "text/markdown; charset=utf-8", body: renderMarkdown(report.data, { id: report.id, generatedAt }) };
}
