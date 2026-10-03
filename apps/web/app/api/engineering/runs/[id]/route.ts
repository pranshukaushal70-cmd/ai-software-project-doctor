import { idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { getRun } from "@/server/services/engine-service";

/** A run with its audit log, changes and diffs, sandbox executions and the test setup awaiting approval. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  return ok(await getRun(user.id, idSchema.parse((await params).id)));
});
