import { findingsQuerySchema, idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { getOwnedAnalysis } from "@/server/services/analysis-service";
import { listFindings } from "@/server/services/findings-service";

/** Evidence-backed findings, most severe first, with severity/type facet counts. */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser();
  const id = idSchema.parse((await params).id);
  const analysis = await getOwnedAnalysis(user.id, id);
  const q = findingsQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return ok(await listFindings(id, analysis.repositoryId, q));
});
