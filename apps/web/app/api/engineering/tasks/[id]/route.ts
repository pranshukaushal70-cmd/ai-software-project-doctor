import { idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { getTask } from "@/server/services/engineering-service";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  return ok(await getTask(user.id, idSchema.parse((await params).id)));
});
