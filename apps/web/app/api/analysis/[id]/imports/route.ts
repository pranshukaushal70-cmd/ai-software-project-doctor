import { idSchema, importsQuerySchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { getOwnedAnalysis } from "@/server/services/analysis-service";
import { fileImports, isIndexed } from "@/server/services/intelligence-service";

/** `?path=&direction=imports|importers`: a file's resolved imports, or the files importing it. */
export const GET = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser();
  const analysis = await getOwnedAnalysis(user.id, idSchema.parse((await params).id));
  const q = importsQuerySchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  if (!isIndexed(analysis)) return ok({ indexed: false, file: null, imports: [], importers: [] });
  return ok({ indexed: true, ...(await fileImports(analysis.id, q)) });
});
