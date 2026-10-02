import { contextRequestSchema, idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, readJson, route } from "@/server/http";
import { getOwnedAnalysis } from "@/server/services/analysis-service";
import { answerContext, isIndexed } from "@/server/services/intelligence-service";

/**
 * Structured repository context for AI agents: `{ operation, ... }` in, bounded structured
 * results out (never file contents). Read-only; POST because the request is a structured
 * document, so the same-origin check of every POST applies.
 */
export const POST = route<{ id: string }>(async (req, { params }) => {
  const user = await requireApiUser();
  const analysis = await getOwnedAnalysis(user.id, idSchema.parse((await params).id));
  const body = contextRequestSchema.parse(await readJson(req));
  if (!isIndexed(analysis)) return ok({ indexed: false, operation: body.operation, result: null });
  return ok({ indexed: true, operation: body.operation, result: await answerContext(analysis, body) });
});
