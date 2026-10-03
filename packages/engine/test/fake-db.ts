/**
 * In-memory stand-in for the Prisma calls the engine makes. It implements the
 * semantics the engine relies on: compare-and-set updateMany (equality, `in`,
 * `not: null`), `increment`, interactive transactions, and the ownership filters
 * of the control functions.
 */

type Row = Record<string, any>;

const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("in" in v) return (v.in as unknown[]).includes(row[k]);
      if ("not" in v) return row[k] !== v.not && row[k] != null;
    }
    return row[k] === v;
  });

const apply = (row: Row, data: Row) => {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && "increment" in v) row[k] = (row[k] ?? 0) + v.increment;
    else row[k] = v;
  }
  row.updatedAt = new Date();
};

export interface Fixture {
  userId: string;
  analysis: Row;
  repository: Row;
  task: Row;
  plan: Row;
  files: Array<{ path: string; kind: string; contentHash: string | null }>;
}

export function fakeDb(f: Fixture) {
  let seq = 0;
  const id = (p: string) => `${p}${++seq}`;
  const runs: Row[] = [];
  const events: Row[] = [];
  const changes: Row[] = [];
  const executions: Row[] = [];
  const plans: Row[] = [f.plan];
  const fileRows = f.files.map((x, i) => ({ id: `f${i}`, analysisId: f.analysis.id, ...x }));

  const planView = (p: Row) => ({ ...p, task: { ...f.task, analysis: { ...f.analysis, repository: f.repository } } });
  const ownsPlan = (p: Row, w: Row | undefined) =>
    !w || (f.task.userId === w.userId && f.repository.userId === w.analysis?.repository?.userId && p.taskId === f.task.id);
  const runView = (r: Row, select?: Row) => {
    const plan = plans.find((p) => p.id === r.planId)!;
    const out: Row = { ...r };
    if (select?.plan) out.plan = planView(plan);
    return out;
  };

  const db: Row = {
    runs,
    events,
    changes,
    executions,
    plans,
    async $transaction(fn: (tx: Row) => Promise<unknown>) {
      return fn(db);
    },
    engineeringPlan: {
      findFirst: async ({ where }: { where: Row }) => {
        const p = plans.find((x) => x.id === where.id);
        return p && ownsPlan(p, where.task) ? planView(p) : null;
      },
    },
    engineeringRun: {
      create: async ({ data }: { data: Row }) => {
        const r = {
          id: id("run"),
          status: "QUEUED",
          iteration: 0,
          inputTokens: 0,
          outputTokens: 0,
          installApproved: false,
          executionApprovedAt: null,
          cancelRequestedAt: null,
          commitSha: null,
          testCommand: null,
          testSetup: null,
          patch: null,
          summary: null,
          notes: null,
          failureReason: null,
          error: null,
          startedAt: null,
          finishedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        runs.push(r);
        return { ...r };
      },
      count: async ({ where }: { where: Row }) => runs.filter((r) => matches(r, where)).length,
      findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
        const r = runs.find((x) => x.id === where.id);
        return r ? runView(r, select) : null;
      },
      findFirst: async ({ where, select }: { where: Row; select?: Row }) => {
        const r = runs.find((x) => x.id === where.id && x.userId === where.userId);
        if (!r) return null;
        const plan = plans.find((p) => p.id === r.planId)!;
        return ownsPlan(plan, where.plan?.task) ? runView(r, select) : null;
      },
      findMany: async ({ where }: { where: Row }) => runs.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      findUniqueOrThrow: async ({ where }: { where: Row }) => {
        const r = runs.find((x) => x.id === where.id);
        if (!r) throw new Error("not found");
        return { ...r };
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const r = runs.find((x) => x.id === where.id)!;
        apply(r, data);
        return { ...r };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hits = runs.filter((r) => matches(r, where));
        for (const r of hits) apply(r, data);
        return { count: hits.length };
      },
    },
    engineeringRunEvent: {
      create: async ({ data }: { data: Row }) => void events.push({ id: id("ev"), createdAt: new Date(), ...data }),
      findMany: async ({ where }: { where: Row }) => events.filter((e) => e.runId === where.runId).map((e) => ({ ...e })),
    },
    engineeringChange: {
      createMany: async ({ data }: { data: Row[] }) => {
        changes.push(...data.map((d) => ({ id: id("ch"), ...d })));
        return { count: data.length };
      },
      findMany: async ({ where }: { where: Row }) => changes.filter((c) => c.runId === where.runId).map((c) => ({ ...c })),
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hits = changes.filter((c) => matches(c, where));
        for (const c of hits) Object.assign(c, data);
        return { count: hits.length };
      },
    },
    sandboxExecution: {
      create: async ({ data }: { data: Row }) => void executions.push({ id: id("ex"), startedAt: new Date(), ...data }),
      findMany: async ({ where }: { where: Row }) => executions.filter((e) => e.runId === where.runId).map((e) => ({ ...e })),
    },
    file: { findMany: async ({ where }: { where: Row }) => fileRows.filter((x) => x.analysisId === where.analysisId) },
    fileDependency: { findMany: async () => [] },
    codeSymbol: { findMany: async () => [] },
    symbolReference: { findMany: async () => [] },
  };
  return db as Row & { runs: Row[]; events: Row[]; changes: Row[]; executions: Row[]; plans: Row[] };
}
