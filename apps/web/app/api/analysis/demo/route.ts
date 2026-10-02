import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { createDemoAnalysis } from "@/server/services/analysis-service";

/**
 * Analyse the bundled demo project (a deliberately flawed sample application).
 * No body; returns 202 { analysisId, status: "queued" } like POST /api/analysis.
 */
export const POST = route(async () => {
  const user = await requireApiUser();
  await rateLimit("analysis", user.id);
  return ok(await createDemoAnalysis(user.id, "LOCAL_ONLY"), { status: 202 });
});
