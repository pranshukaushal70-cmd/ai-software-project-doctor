import { idSchema, referencesQuerySchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { getOwnedAnalysis } from "@/server/services/analysis-service";
import { isIndexed, listReferences } from "@/server/services/intelligence-service";

/** Call sites: `?symbolId=` (resolved calls of that symbol) or `?name=` (every call of that name), paginated. */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser();
  const analysis = await getOwnedAnalysis(user.id, idSchema.parse((await params).id));
  const q = referencesQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  if (!isIndexed(analysis)) return ok({ indexed: false, references: [], total: 0, page: q.page, pageSize: q.pageSize });
  return ok({ indexed: true, ...(await listReferences(analysis.id, q)) });
});
