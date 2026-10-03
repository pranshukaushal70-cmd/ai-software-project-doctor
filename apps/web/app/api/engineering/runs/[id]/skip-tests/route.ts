import { idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { skipRunExecution } from "@/server/services/engine-service";

/** Review the change without running anything. */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  return ok(await skipRunExecution(user.id, idSchema.parse((await params).id)));
});
