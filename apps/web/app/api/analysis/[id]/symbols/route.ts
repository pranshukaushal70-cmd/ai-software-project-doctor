import { idSchema, symbolsQuerySchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { getOwnedAnalysis } from "@/server/services/analysis-service";
import { isIndexed, listSymbols } from "@/server/services/intelligence-service";

/** Symbol definitions: `?q=` (name, case-insensitive), `kind=`, `path=`, `exported=`, paginated. */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser();
  const analysis = await getOwnedAnalysis(user.id, idSchema.parse((await params).id));
  const q = symbolsQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  if (!isIndexed(analysis)) return ok({ indexed: false, symbols: [], total: 0, page: q.page, pageSize: q.pageSize });
  return ok({ indexed: true, ...(await listSymbols(analysis.id, q)) });
});
