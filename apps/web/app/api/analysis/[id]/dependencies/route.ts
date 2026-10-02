import { dependenciesQuerySchema, idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { getOwnedAnalysis } from "@/server/services/analysis-service";
import { dependencySummaryOf, listDependencies } from "@/server/services/dependency-service";

/**
 * Declared and locked dependencies with OSV.dev vulnerability data, filters,
 * pagination and ecosystem facet counts. `summary` is null until the
 * dependency analysis has run for this analysis.
 */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser();
  const id = idSchema.parse((await params).id);
  const analysis = await getOwnedAnalysis(user.id, id);
  const q = dependenciesQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return ok(await listDependencies(id, q, dependencySummaryOf(analysis.summary)));
});
