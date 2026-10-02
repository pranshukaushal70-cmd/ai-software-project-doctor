import { idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { getOwnedAnalysis } from "@/server/services/analysis-service";
import { isIndexed, modulesOf } from "@/server/services/intelligence-service";

/** Modules (directories at the architecture depth) with file, test and symbol counts and coupling metrics. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  const analysis = await getOwnedAnalysis(user.id, idSchema.parse((await params).id));
  return ok({ indexed: isIndexed(analysis), modules: modulesOf(analysis) ?? [] });
});
