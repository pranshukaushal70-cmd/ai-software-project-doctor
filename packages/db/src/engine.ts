import { canTransition, EXECUTION_RUN_STATUSES, isTerminalRunStatus, type EngineeringRunStatus } from "@pd/shared/engine";
import type { Prisma, PrismaClient } from "./generated/prisma/client";

export type RunActor = "user" | "worker";

export interface RunTransition {
  from: EngineeringRunStatus;
  to: EngineeringRunStatus;
  actor: RunActor;
  /** User-safe description for the audit log; never prompts, file contents or credentials. */
  message: string;
  /** Other run columns to set in the same update (e.g. failureReason, executionApprovedAt). */
  patch?: Omit<Prisma.EngineeringRunUpdateManyMutationInput, "status">;
  data?: Prisma.InputJsonValue;
}

type TransitionClient = Pick<PrismaClient, "$transaction">;

/**
 * Moves a code-engine run from `from` to `to` if — and only if — the transition is
 * allowed and the run is still in `from` (compare-and-set), and records the change
 * in the run's audit log in the same transaction. Returns false when the run had
 * already moved on (a concurrent cancel, a retried job) or a gate is not satisfied,
 * so callers never overwrite a newer status. Throws on a transition the lifecycle
 * does not allow: that is a bug.
 *
 * Gates are part of the compare-and-set, so they hold however the caller got here:
 * - INSTALLING and TESTING run repository code: the row must have `executionApprovedAt`,
 *   or this very update must record the approval (allowed only from AWAITING_APPROVAL).
 * - INSTALLING has network access: the row (or this update) must have `installApproved`.
 */
export async function transitionRun(prisma: TransitionClient, runId: string, t: RunTransition): Promise<boolean> {
  if (!canTransition(t.from, t.to)) throw new Error(`Invalid engineering run transition ${t.from} → ${t.to}`);
  const approvesNow = t.patch?.executionApprovedAt != null;
  if (approvesNow && t.from !== "AWAITING_APPROVAL") throw new Error("Execution can only be approved from AWAITING_APPROVAL");
  const where: Prisma.EngineeringRunWhereInput = { id: runId, status: t.from };
  if (EXECUTION_RUN_STATUSES.includes(t.to) && !approvesNow) where.executionApprovedAt = { not: null };
  if (t.to === "INSTALLING" && t.patch?.installApproved !== true) where.installApproved = true;

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const { count } = await tx.engineeringRun.updateMany({
      where,
      data: { ...t.patch, status: t.to, ...(isTerminalRunStatus(t.to) ? { finishedAt: now } : {}) },
    });
    if (count === 0) return false;
    await tx.engineeringRunEvent.create({
      data: { runId, type: "status", actor: t.actor, fromStatus: t.from, toStatus: t.to, message: t.message, data: t.data, createdAt: now },
    });
    return true;
  });
}
