import { executionApprovalSchema, idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, readJson, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { approveRunExecution } from "@/server/services/engine-service";

/**
 * Second gate: approve running the run's test command (shown by GET) in the sandbox.
 * `{ install: true }` also approves the separate, network-enabled dependency install.
 */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser();
  const runId = idSchema.parse((await params).id);
  const approval = executionApprovalSchema.parse(await readJson(req));
  await rateLimit("engine", user.id);
  return ok(await approveRunExecution(user.id, runId, approval));
});
