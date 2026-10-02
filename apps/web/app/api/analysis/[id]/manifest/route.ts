import { idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { getOwnedAnalysis } from "@/server/services/analysis-service";
import { isIndexed, manifestOf } from "@/server/services/intelligence-service";

/** Repository manifest: languages, frameworks, runtimes, manifests, CI, Docker, directories and file roles. */
export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  const analysis = await getOwnedAnalysis(user.id, idSchema.parse((await params).id));
  return ok({ indexed: isIndexed(analysis), ...(manifestOf(analysis) ?? { manifest: null, totals: null }) });
});
