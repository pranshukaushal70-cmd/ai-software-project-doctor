import { idSchema, triageInputSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, readJson, route } from "@/server/http";
import { getOwnedAnalysis } from "@/server/services/analysis-service";
import { clearTriage, setTriage } from "@/server/services/triage-service";

/**
 * Mark one finding as Expected or Ignored (PUT) or clear the mark (DELETE). The
 * decision is stored for the analysis's repository and the finding's fingerprint,
 * so it follows that exact finding across re-analyses and never hides others.
 */
export const PUT = route<{ id: string; findingId: string }>(async (req, { params }) => {
  const user = await requireApiUser();
  const p = await params;
  const analysis = await getOwnedAnalysis(user.id, idSchema.parse(p.id));
  const findingId = idSchema.parse(p.findingId);
  const input = triageInputSchema.parse(await readJson(req));
  return ok({ triage: await setTriage(user.id, analysis, findingId, input) });
});

export const DELETE = route<{ id: string; findingId: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  const p = await params;
  const analysis = await getOwnedAnalysis(user.id, idSchema.parse(p.id));
  const findingId = idSchema.parse(p.findingId);
  return ok(await clearTriage(analysis, findingId));
});
