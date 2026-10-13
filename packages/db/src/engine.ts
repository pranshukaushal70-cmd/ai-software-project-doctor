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
 * - REPAIRING after TESTING applies and tests model-written code the user has not seen:
 *   the run's test approval must have recorded the user's consent (readRepairApproval).
 */
export async function transitionRun(prisma: TransitionClient, runId: string, t: RunTransition): Promise<boolean> {
  if (!canTransition(t.from, t.to)) throw new Error(`Invalid engineering run transition ${t.from} → ${t.to}`);
  const approvesNow = t.patch?.executionApprovedAt != null;
  if (approvesNow && t.from !== "AWAITING_APPROVAL") throw new Error("Execution can only be approved from AWAITING_APPROVAL");
  const where: Prisma.EngineeringRunWhereInput = { id: runId, status: t.from };
  if (EXECUTION_RUN_STATUSES.includes(t.to) && !approvesNow) where.executionApprovedAt = { not: null };
  if (t.to === "INSTALLING" && t.patch?.installApproved !== true) where.installApproved = true;

  return prisma.$transaction(async (tx) => {
    if (t.from === "TESTING" && t.to === "REPAIRING" && (await readRepairApproval(tx, runId)) !== true) return false;
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

type RepairApprovalClient = { engineeringRunEvent: Pick<PrismaClient["engineeringRunEvent"], "findFirst"> };
type RepairStateClient = { engineeringRunEvent: Pick<PrismaClient["engineeringRunEvent"], "findFirst" | "count"> };

/** The run's test approval: the user's move out of AWAITING_APPROVAL into INSTALLING or TESTING (at most once per run). */
async function approvalEventData(prisma: RepairApprovalClient, runId: string): Promise<{ repair?: unknown; repairAttempts?: unknown } | null> {
  const event = await prisma.engineeringRunEvent.findFirst({
    where: { runId, type: "status", actor: "user", fromStatus: "AWAITING_APPROVAL", toStatus: { in: ["INSTALLING", "TESTING"] } },
    orderBy: { createdAt: "desc" },
    select: { data: true },
  });
  const data = event?.data;
  return data && typeof data === "object" && !Array.isArray(data) ? (data as { repair?: unknown; repairAttempts?: unknown }) : null;
}

/**
 * The user's decision on repair attempts after failing tests, recorded on the run's test approval
 * event: true or false as recorded; null when the run's tests were never approved, or were
 * approved before the decision was recorded.
 */
export async function readRepairApproval(prisma: RepairApprovalClient, runId: string): Promise<boolean | null> {
  const repair = (await approvalEventData(prisma, runId))?.repair;
  return typeof repair === "boolean" ? repair : null;
}

export interface RepairState {
  /** The decision recorded at the test approval (see readRepairApproval). */
  approved: boolean | null;
  /** Repair attempts the run's budget allowed when the user consented; 0 without consent; null when not recorded. */
  attemptsAllowed: number | null;
  /** Repair rounds that actually started after failing tests (TESTING → REPAIRING in the audit log). */
  attemptsUsed: number;
}

/** What the run view and reports show about repairs: the decision, the attempts it allowed, and the attempts used. */
export async function readRepairState(prisma: RepairStateClient, runId: string): Promise<RepairState> {
  const [data, attemptsUsed] = await Promise.all([
    approvalEventData(prisma, runId),
    prisma.engineeringRunEvent.count({ where: { runId, type: "status", fromStatus: "TESTING", toStatus: "REPAIRING" } }),
  ]);
  const approved = typeof data?.repair === "boolean" ? data.repair : null;
  const allowed = data?.repairAttempts;
  return { approved, attemptsAllowed: approved === null ? null : typeof allowed === "number" ? allowed : 0, attemptsUsed };
}
