import { idSchema } from "@pd/shared";
import { requireApiUser } from "@/server/auth/session";
import { ok, route } from "@/server/http";
import { getOwnedAnalysis } from "@/server/services/analysis-service";

export const GET = route<{ id: string }>(async (_req, { params }) => {
  const user = await requireApiUser();
  const id = idSchema.parse((await params).id);
  const a = await getOwnedAnalysis(user.id, id);
  return ok({
    id: a.id,
    status: a.status,
    stage: a.stage,
    progress: a.progress,
    mode: a.mode,
    analyzerVersion: a.analyzerVersion,
    commitSha: a.commitSha,
    error: a.error,
    summary: a.summary,
    healthScore: a.healthScore,
    createdAt: a.createdAt,
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
    repository: a.repository,
  });
});
