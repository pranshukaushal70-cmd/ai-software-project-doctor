import { idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { getLatestPlan, requestPlan } from "@/server/services/engineering-service";

/**
 * Request a plan for a task. Responds 202 with the PENDING plan at once; context
 * retrieval, the LLM call and validation run in the worker. Poll GET for the result.
 */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  const taskId = idSchema.parse((await params).id);
  await rateLimit("ai", user.id);
  return ok(await requestPlan(user.id, taskId), { status: 202 });
});

/** The task's latest plan with its evidence and validation report (`null` before any plan was requested). */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  return ok(await getLatestPlan(user.id, idSchema.parse((await params).id)));
});
