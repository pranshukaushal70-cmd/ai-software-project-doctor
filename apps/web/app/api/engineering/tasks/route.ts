import { engineeringTaskSchema, idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, readJson, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { createTask, listTasks } from "@/server/services/engineering-service";

/** Create an engineering task for one of the user's analyses. Records the task only; planning is a separate request. */
export const POST = route(async (req) => {
  const user = await requireApiUser();
  const input = engineeringTaskSchema.parse(await readJson(req));
  await rateLimit("ai", user.id);
  return ok(await createTask(user.id, input), { status: 201 });
});

/** `?analysisId=` → the user's tasks for that analysis, newest first, with their latest plan status. */
export const GET = route(async (req) => {
  const user = await requireApiUser();
  const analysisId = idSchema.parse(req.nextUrl.searchParams.get("analysisId") ?? "");
  return ok(await listTasks(user.id, analysisId));
});
