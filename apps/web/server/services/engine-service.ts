import "server-only";
import { getPrisma } from "@pd/db";
import { AppError } from "@pd/shared";
import { createLogger } from "@pd/shared/logger";

/**
 * Code engine (Phase 8), web side. Approving a plan is the first gate: no change is
 * generated for a plan the owner has not approved. Runs, the second gate (approving
 * the sandboxed test command) and the patch download build on this in later
 * milestones. Nothing here reads or changes a repository.
 */

const log = createLogger("engine");

/** The plan, if it belongs to the user (directly through its task and through the task's analysis); 404 otherwise. */
async function ownedPlan(userId: string, planId: string) {
  const plan = await getPrisma().engineeringPlan.findFirst({
    where: { id: planId, task: { userId, analysis: { repository: { userId } } } },
    select: { id: true, taskId: true, status: true, validationStatus: true, approvedAt: true },
  });
  if (!plan) throw new AppError("NOT_FOUND", "Plan not found");
  return plan;
}

/**
 * Approves a plan for the code engine. Only the task's latest plan can be approved,
 * and only once it has completed (a rejected or failed plan never completes).
 * Approving an approved plan again is a no-op that returns the original time.
 */
export async function approvePlan(userId: string, planId: string): Promise<{ id: string; approvedAt: Date }> {
  const prisma = getPrisma();
  const plan = await ownedPlan(userId, planId);
  if (plan.approvedAt) return { id: plan.id, approvedAt: plan.approvedAt };
  const latest = await prisma.engineeringPlan.findFirst({ where: { taskId: plan.taskId }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (latest?.id !== plan.id) throw new AppError("CONFLICT", "A newer plan exists for this task; review and approve that one instead.");
  if (plan.status !== "COMPLETED" || plan.validationStatus === "REJECTED") throw new AppError("CONFLICT", "Only a completed plan can be approved.");

  // Compare-and-set: a concurrent approval keeps the first timestamp.
  await prisma.engineeringPlan.updateMany({ where: { id: plan.id, status: "COMPLETED", approvedAt: null }, data: { approvedAt: new Date() } });
  const { approvedAt } = await prisma.engineeringPlan.findUniqueOrThrow({ where: { id: plan.id }, select: { approvedAt: true } });
  log.info({ planId: plan.id, validation: plan.validationStatus }, "plan approved");
  return { id: plan.id, approvedAt: approvedAt! };
}
