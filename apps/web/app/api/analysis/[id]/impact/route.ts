import { idSchema, impactQuerySchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { getOwnedAnalysis } from "@/server/services/analysis-service";
import { impactOf, isIndexed } from "@/server/services/intelligence-service";

/** Deterministic impact analysis: `?type=file|symbol|module&target=&path=&depth=`. */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser();
  const analysis = await getOwnedAnalysis(user.id, idSchema.parse((await params).id));
  const q = impactQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  if (!isIndexed(analysis)) return ok({ indexed: false, impact: null });
  return ok({ indexed: true, impact: await impactOf(analysis, q) });
});
