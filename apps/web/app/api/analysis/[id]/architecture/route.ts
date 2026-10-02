import { architectureQuerySchema, idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { getOwnedAnalysis } from "@/server/services/analysis-service";
import { architectureSummaryOf, getArchitectureGraph } from "@/server/services/architecture-service";

/**
 * The module graph (`view=modules`, default) or file import graph
 * (`view=files`, optionally `module=` and `cycles=true`), most connected nodes
 * first, with the architecture summary (cycles, layers, hubs). `summary` is
 * null until the architecture analysis has run for this analysis.
 */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser();
  const id = idSchema.parse((await params).id);
  const analysis = await getOwnedAnalysis(user.id, id);
  const q = architectureQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  return ok(await getArchitectureGraph(id, q, architectureSummaryOf(analysis.summary)));
});
