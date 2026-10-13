import { describe, expect, it } from "vitest";
import { ENGINEERING_RUN_STATUSES } from "@pd/shared/engine";
import { readRepairApproval, readRepairState, transitionRun } from "../src/engine";
import { EngineeringRunStatus } from "../src/generated/prisma/enums";

type Row = Record<string, any>;

/** Interprets the subset of `where` that transitionRun uses: equality and `{ not: null }`. */
const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([k, v]) => (v && typeof v === "object" && "not" in v ? row[k] !== v.not && row[k] != null : row[k] === v));

/** Interprets the event filters of readRepairApproval / readRepairState: equality and `{ in: [...] }`. */
const matchesEvent = (e: Row, where: Row) =>
  Object.entries(where).every(([k, v]) => (v && typeof v === "object" && "in" in v ? (v.in as unknown[]).includes(e[k]) : e[k] === v));

function fakeDb(run: Row, seeded: Row[] = []) {
  const events: Row[] = [...seeded];
  const eventApi = {
    create: async ({ data }: { data: Row }) => void events.push(data),
    // Latest matching event (kept in creation order).
    findFirst: async ({ where }: { where: Row }) => events.filter((e) => matchesEvent(e, where)).at(-1) ?? null,
    count: async ({ where }: { where: Row }) => events.filter((e) => matchesEvent(e, where)).length,
  };
  const tx = {
    engineeringRun: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(run, where)) return { count: 0 };
        Object.assign(run, data);
        return { count: 1 };
      },
    },
    engineeringRunEvent: eventApi,
  };
  return { run, events, client: { $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx), engineeringRunEvent: eventApi } as any };
}

/** A user's test approval event, as approveExecution records it. */
const approvalEvent = (runId: string, data: Row | null, toStatus = "TESTING") => ({ runId, type: "status", actor: "user", fromStatus: "AWAITING_APPROVAL", toStatus, message: "Approved.", data });

const baseRun = (over: Row = {}): Row => ({ id: "r1", status: "QUEUED", executionApprovedAt: null, installApproved: false, finishedAt: null, ...over });

describe("transitionRun", () => {
  it("keeps the Prisma enum and the shared lifecycle in sync", () => {
    expect(Object.values(EngineeringRunStatus)).toEqual([...ENGINEERING_RUN_STATUSES]);
  });

  it("moves an allowed transition and records it in the audit log", async () => {
    const db = fakeDb(baseRun());
    expect(await transitionRun(db.client, "r1", { from: "QUEUED", to: "MATERIALIZING", actor: "worker", message: "Fetching the analysed commit.", patch: { startedAt: new Date(5) } })).toBe(true);
    expect(db.run).toMatchObject({ status: "MATERIALIZING", startedAt: new Date(5), finishedAt: null });
    expect(db.events).toEqual([expect.objectContaining({ runId: "r1", type: "status", actor: "worker", fromStatus: "QUEUED", toStatus: "MATERIALIZING", message: "Fetching the analysed commit." })]);
  });

  it("does nothing when the run already moved on (compare-and-set)", async () => {
    const db = fakeDb(baseRun({ status: "CANCELLED" }));
    expect(await transitionRun(db.client, "r1", { from: "QUEUED", to: "MATERIALIZING", actor: "worker", message: "x" })).toBe(false);
    expect(db.run.status).toBe("CANCELLED");
    expect(db.events).toEqual([]);
  });

  it("throws on transitions the lifecycle does not allow", async () => {
    const db = fakeDb(baseRun());
    await expect(transitionRun(db.client, "r1", { from: "QUEUED", to: "TESTING", actor: "worker", message: "x" })).rejects.toThrow(/Invalid engineering run transition/);
    await expect(transitionRun(db.client, "r1", { from: "DISCARDED", to: "READY_FOR_REVIEW", actor: "user", message: "x" })).rejects.toThrow();
    expect(db.run.status).toBe("QUEUED");
  });

  it("stamps finishedAt on terminal statuses", async () => {
    const db = fakeDb(baseRun({ status: "GENERATING" }));
    expect(await transitionRun(db.client, "r1", { from: "GENERATING", to: "FAILED", actor: "worker", message: "The model declined.", patch: { failureReason: "refused" } })).toBe(true);
    expect(db.run).toMatchObject({ status: "FAILED", failureReason: "refused" });
    expect(db.run.finishedAt).toBeInstanceOf(Date);
  });

  describe("execution gate", () => {
    it("refuses to run tests without the user's approval", async () => {
      // A first iteration cannot go APPLYING → TESTING on its own …
      const db = fakeDb(baseRun({ status: "APPLYING" }));
      expect(await transitionRun(db.client, "r1", { from: "APPLYING", to: "TESTING", actor: "worker", message: "x" })).toBe(false);
      expect(db.run.status).toBe("APPLYING");
      // … but a repair iteration of an approved run can.
      db.run.executionApprovedAt = new Date(1);
      expect(await transitionRun(db.client, "r1", { from: "APPLYING", to: "TESTING", actor: "worker", message: "Re-running the approved tests." })).toBe(true);
    });

    it("records the approval and the move in one update, only from AWAITING_APPROVAL", async () => {
      const db = fakeDb(baseRun({ status: "AWAITING_APPROVAL" }));
      const approval = { executionApprovedAt: new Date(9), testCommand: "npm-test" };
      expect(await transitionRun(db.client, "r1", { from: "AWAITING_APPROVAL", to: "TESTING", actor: "user", message: "Tests approved.", patch: approval })).toBe(true);
      expect(db.run).toMatchObject({ status: "TESTING", executionApprovedAt: new Date(9), testCommand: "npm-test" });

      const other = fakeDb(baseRun({ status: "APPLYING" }));
      await expect(transitionRun(other.client, "r1", { from: "APPLYING", to: "TESTING", actor: "worker", message: "x", patch: approval })).rejects.toThrow(/AWAITING_APPROVAL/);
      expect(other.run.status).toBe("APPLYING");
    });

    it("requires the separate install approval for the network-enabled install step", async () => {
      const db = fakeDb(baseRun({ status: "AWAITING_APPROVAL" }));
      expect(await transitionRun(db.client, "r1", { from: "AWAITING_APPROVAL", to: "INSTALLING", actor: "user", message: "x", patch: { executionApprovedAt: new Date(1) } })).toBe(false);
      expect(db.run.status).toBe("AWAITING_APPROVAL");
      expect(await transitionRun(db.client, "r1", { from: "AWAITING_APPROVAL", to: "INSTALLING", actor: "user", message: "Install and tests approved.", patch: { executionApprovedAt: new Date(1), installApproved: true } })).toBe(true);
      expect(db.run).toMatchObject({ status: "INSTALLING", installApproved: true });
      expect(await transitionRun(db.client, "r1", { from: "INSTALLING", to: "TESTING", actor: "worker", message: "Dependencies installed." })).toBe(true);
    });

    it("refuses a repair after failing tests unless this run's test approval recorded consent", async () => {
      const tested = () => baseRun({ status: "TESTING", executionApprovedAt: new Date(1) });
      const repair = { from: "TESTING" as const, to: "REPAIRING" as const, actor: "worker" as const, message: "Repair attempt 1." };
      // Another run's consent does not count, nor does a missing or legacy decision.
      for (const seeded of [[], [approvalEvent("r2", { repair: true })], [approvalEvent("r1", { repair: false }), approvalEvent("r2", { repair: true })], [approvalEvent("r1", null)], [approvalEvent("r1", { test: "npm-test" })]]) {
        const db = fakeDb(tested(), seeded);
        expect(await transitionRun(db.client, "r1", repair)).toBe(false);
        expect(db.run.status).toBe("TESTING");
        expect(db.events).toHaveLength(seeded.length); // nothing recorded
      }
      const db = fakeDb(tested(), [approvalEvent("r2", { repair: false }), approvalEvent("r1", { repair: true }, "INSTALLING")]);
      expect(await transitionRun(db.client, "r1", repair)).toBe(true);
      expect(db.run.status).toBe("REPAIRING");
      // Repairs of changes that failed validation (no test approval involved) are not affected.
      const validating = fakeDb(baseRun({ status: "VALIDATING" }));
      expect(await transitionRun(validating.client, "r1", { from: "VALIDATING", to: "REPAIRING", actor: "worker", message: "Repair attempt 1." })).toBe(true);
    });
  });
});

describe("repair decision and attempts", () => {
  it("are read from the right run's approval event and audit log only", async () => {
    const status = (runId: string, from: string, to: string, actor = "worker") => ({ runId, type: "status", actor, fromStatus: from, toStatus: to, message: "x", data: null });
    const { client } = fakeDb(baseRun(), [
      approvalEvent("r1", { install: null, test: "npm-test", repair: true, repairAttempts: 2 }),
      status("r1", "TESTING", "REPAIRING"),
      status("r1", "REPAIRING", "VALIDATING"),
      status("r1", "VALIDATING", "REPAIRING"), // a validation repair is not a repair after failing tests
      // Other runs: a refusal, a skip (not an approval), a worker move out of AWAITING_APPROVAL, extra repairs.
      approvalEvent("r2", { repair: false, repairAttempts: 0 }),
      status("r2", "TESTING", "REPAIRING"),
      { ...status("r3", "AWAITING_APPROVAL", "READY_FOR_REVIEW", "user"), data: { repair: true } },
      { ...status("r4", "AWAITING_APPROVAL", "CANCELLED", "worker"), data: { repair: true } },
      approvalEvent("r5", { test: "npm-test" }), // approved before the decision was recorded
    ]);
    expect(await readRepairState(client, "r1")).toEqual({ approved: true, attemptsAllowed: 2, attemptsUsed: 1 });
    expect(await readRepairState(client, "r2")).toEqual({ approved: false, attemptsAllowed: 0, attemptsUsed: 1 });
    expect(await readRepairState(client, "r3")).toEqual({ approved: null, attemptsAllowed: null, attemptsUsed: 0 });
    expect(await readRepairState(client, "r4")).toEqual({ approved: null, attemptsAllowed: null, attemptsUsed: 0 });
    expect(await readRepairState(client, "r5")).toEqual({ approved: null, attemptsAllowed: null, attemptsUsed: 0 });
    expect(await readRepairState(client, "unknown")).toEqual({ approved: null, attemptsAllowed: null, attemptsUsed: 0 });
    expect([await readRepairApproval(client, "r1"), await readRepairApproval(client, "r2"), await readRepairApproval(client, "r3")]).toEqual([true, false, null]);
  });
});
