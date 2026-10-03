/**
 * In-memory stand-in for the Prisma calls the reports package makes: the ownership
 * filters (repository owner, task owner, run owner), groupBy counts, ordered and
 * bounded finding lists, and the report table with its (subjectKey, fingerprint)
 * uniqueness. Shared with the web API tests.
 */

type Row = Record<string, any>;

const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

export interface FakeData {
  users: string[];
  repositories: Row[];
  analyses: Row[];
  files: Row[];
  findings: Row[];
  triages: Row[];
  dependencies: Row[];
  tasks: Row[];
  plans: Row[];
  runs: Row[];
  events: Row[];
  changes: Row[];
  executions: Row[];
}

const pick = (row: Row, select?: Row): Row => {
  if (!select) return { ...row };
  const out: Row = {};
  for (const k of Object.keys(select)) if (k in row) out[k] = row[k];
  return out;
};

export function fakeReportsDb(d: FakeData) {
  let seq = 0;
  const reports: Row[] = [];
  const repoOf = (analysisId: string) => d.repositories.find((r) => r.id === d.analyses.find((a) => a.id === analysisId)?.repositoryId);
  const fileOf = (fileId: string | null) => d.files.find((f) => f.id === fileId) ?? null;
  const taskOwned = (t: Row | undefined, w: Row | undefined) => !!t && (!w || (t.userId === w.userId && repoOf(t.analysisId)?.userId === w.analysis?.repository?.userId));
  const planView = (p: Row, select?: Row) => {
    const out = pick(p, select);
    if (select?.task) out.task = pick(d.tasks.find((t) => t.id === p.taskId)!, select.task.select);
    return out;
  };
  const findingMatches = (f: Row, w: Row) =>
    f.analysisId === w.analysisId && (!w.category?.in || w.category.in.includes(f.category)) && (!w.fingerprint?.in || w.fingerprint.in.includes(f.fingerprint));
  const findingsSorted = (rows: Row[]) =>
    [...rows].sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
        String(fileOf(a.fileId)?.path ?? "").localeCompare(String(fileOf(b.fileId)?.path ?? "")) ||
        (a.line ?? 0) - (b.line ?? 0) ||
        a.id.localeCompare(b.id),
    );
  const reportOwned = (r: Row, w: Row) => r.userId === w.userId && d.repositories.find((x) => x.id === r.repositoryId)?.userId === w.repository?.userId;
  const reportMatches = (r: Row, w: Row) =>
    (!("userId" in w) || reportOwned(r, w)) &&
    ["id", "repositoryId", "analysisId", "planId", "runId", "type", "status", "outcome", "subjectKey"].every((k) => !(k in w) || r[k] === w[k]);
  const reportSorted = (rows: Row[]) => [...rows].sort((a, b) => b.generatedAt - a.generatedAt || b.id.localeCompare(a.id));

  const db: Row = {
    reports,
    data: d,
    analysis: {
      findFirst: async ({ where, select }: { where: Row; select: Row }) => {
        const a = d.analyses.find((x) => x.id === where.id && repoOf(x.id)?.userId === where.repository.userId);
        if (!a) return null;
        return { ...pick(a, select), repository: pick(repoOf(a.id)!, select.repository.select) };
      },
    },
    finding: {
      count: async ({ where }: { where: Row }) => d.findings.filter((f) => findingMatches(f, where)).length,
      groupBy: async ({ by, where }: { by: string[]; where: Row }) => {
        const counts = new Map<string, number>();
        for (const f of d.findings.filter((x) => findingMatches(x, where))) counts.set(f[by[0]!], (counts.get(f[by[0]!]) ?? 0) + 1);
        return [...counts.entries()].map(([k, n]) => ({ [by[0]!]: k, _count: { _all: n } }));
      },
      findMany: async ({ where, take }: { where: Row; take: number }) =>
        findingsSorted(d.findings.filter((f) => findingMatches(f, where)))
          .slice(0, take)
          .map((f) => ({ severity: f.severity, category: f.category, ruleId: f.ruleId, title: f.title, line: f.line, fingerprint: f.fingerprint, file: fileOf(f.fileId) ? { path: fileOf(f.fileId)!.path } : null })),
    },
    findingTriage: { findMany: async ({ where }: { where: Row }) => d.triages.filter((t) => t.repositoryId === where.repositoryId).map((t) => ({ fingerprint: t.fingerprint })) },
    dependency: {
      count: async ({ where }: { where: Row }) => d.dependencies.filter((x) => x.analysisId === where.analysisId && (!where.vulnIds || x.vulnIds.length > 0)).length,
    },
    engineeringPlan: {
      findFirst: async ({ where, select }: { where: Row; select: Row }) => {
        if (where.taskId) {
          const latest = d.plans.filter((p) => p.taskId === where.taskId).sort((a, b) => b.createdAt - a.createdAt)[0];
          return latest ? { id: latest.id } : null;
        }
        const p = d.plans.find((x) => x.id === where.id);
        return p && taskOwned(d.tasks.find((t) => t.id === p.taskId), where.task) ? planView(p, select) : null;
      },
    },
    engineeringRun: {
      findFirst: async ({ where, select }: { where: Row; select: Row }) => {
        const r = d.runs.find((x) => x.id === where.id && x.userId === where.userId);
        const p = r && d.plans.find((x) => x.id === r.planId);
        if (!r || !p || !taskOwned(d.tasks.find((t) => t.id === p.taskId), where.plan.task)) return null;
        return { ...pick(r, select), plan: planView(p, select.plan.select) };
      },
      count: async ({ where }: { where: Row }) => d.runs.filter((r) => r.id === where.id && r.patch !== null && r.patch !== undefined).length,
    },
    engineeringRunEvent: {
      findMany: async ({ where, take }: { where: Row; take: number }) =>
        d.events
          .filter((e) => e.runId === where.runId)
          .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
          .slice(0, take)
          .map(({ type, actor, fromStatus, toStatus, message, createdAt }) => ({ type, actor, fromStatus, toStatus, message, createdAt })),
    },
    engineeringChange: {
      findMany: async ({ where, take }: { where: Row; take: number }) =>
        d.changes
          .filter((c) => c.runId === where.runId)
          .sort((a, b) => a.iteration - b.iteration || a.path.localeCompare(b.path))
          .slice(0, take)
          .map(({ iteration, path, operation, status, reason, additions, deletions, flags }) => ({ iteration, path, operation, status, reason, additions, deletions, flags })),
    },
    sandboxExecution: {
      findMany: async ({ where, take }: { where: Row; take: number }) =>
        d.executions
          .filter((e) => e.runId === where.runId)
          .slice(0, take)
          .map(({ runId: _r, id: _i, ...rest }) => rest),
    },
    report: {
      findUnique: async ({ where, select }: { where: Row; select: Row }) => {
        const k = where.subjectKey_fingerprint;
        const r = reports.find((x) => x.subjectKey === k.subjectKey && x.fingerprint === k.fingerprint);
        return r ? pick(r, select) : null;
      },
      create: async ({ data, select }: { data: Row; select: Row }) => {
        if (reports.some((x) => x.subjectKey === data.subjectKey && x.fingerprint === data.fingerprint)) throw Object.assign(new Error("unique"), { code: "P2002" });
        const now = new Date(Date.UTC(2026, 9, 3, 12, 0, ++seq));
        const r = { id: `rep${String(seq).padStart(3, "0")}`, generatedAt: now, updatedAt: now, ...data };
        reports.push(r);
        return pick(r, select);
      },
      findFirst: async ({ where, select }: { where: Row; select: Row }) => {
        const r = reportSorted(reports.filter((x) => reportMatches(x, where)))[0];
        return r ? pick(r, select) : null;
      },
      count: async ({ where }: { where: Row }) => reports.filter((x) => reportMatches(x, where)).length,
      findMany: async ({ where, skip, take, select }: { where: Row; skip: number; take: number; select: Row }) =>
        reportSorted(reports.filter((x) => reportMatches(x, where)))
          .slice(skip, skip + take)
          .map((r) => {
            const out = pick(r, select);
            if (select.repository) out.repository = pick(d.repositories.find((x) => x.id === r.repositoryId)!, select.repository.select);
            return out;
          }),
    },
  };
  return db;
}
