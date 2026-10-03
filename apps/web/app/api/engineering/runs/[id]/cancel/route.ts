import { idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { cancelEngineRun } from "@/server/services/engine-service";

/** Cancel a run: at once when it waits, at the worker's next step when it is being processed. */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  return ok(await cancelEngineRun(user.id, idSchema.parse((await params).id)));
});
