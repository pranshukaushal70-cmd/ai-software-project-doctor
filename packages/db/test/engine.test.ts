import { describe, expect, it } from "vitest";
import { ENGINEERING_RUN_STATUSES } from "@pd/shared/engine";
import { transitionRun } from "../src/engine";
import { EngineeringRunStatus } from "../src/generated/prisma/enums";

type Row = Record<string, any>;

/** Interprets the subset of `where` that transitionRun uses: equality and `{ not: null }`. */
const matches = (row: Row, where: Row) =>
  Object.entries(where).every(([k, v]) => (v && typeof v === "object" && "not" in v ? row[k] !== v.not && row[k] != null : row[k] === v));

function fakeDb(run: Row) {
  const events: Row[] = [];
  const tx = {
    engineeringRun: {
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(run, where)) return { count: 0 };
        Object.assign(run, data);
        return { count: 1 };
      },
    },
    engineeringRunEvent: { create: async ({ data }: { data: Row }) => void events.push(data) },
  };
  return { run, events, client: { $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as any };
}

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
  });
});
