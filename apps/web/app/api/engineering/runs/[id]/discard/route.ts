import { idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { discardEngineRun } from "@/server/services/engine-service";

/** Discard a result ready for review; its stored code (patch and diffs) is deleted. */
export const POST = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  return ok(await discardEngineRun(user.id, idSchema.parse((await params).id)));
});
