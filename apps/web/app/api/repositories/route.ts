import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { listRepositories } from "@/server/services/analysis-service";

export const GET = route(async () => {
  const user = await requireApiUser();
  return ok({ repositories: await listRepositories(user.id) });
});
