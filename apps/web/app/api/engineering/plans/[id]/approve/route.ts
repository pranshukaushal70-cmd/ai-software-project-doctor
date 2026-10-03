import { idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { approvePlan } from "@/server/services/engine-service";

/**
 * Approve a completed plan for the code engine (Phase 8, first gate). Records the
 * approval only: nothing is generated, run or changed by this request.
 */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  return ok(await approvePlan(user.id, idSchema.parse((await params).id)));
});
