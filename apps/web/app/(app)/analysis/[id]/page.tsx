import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppError, idSchema } from "@pd/shared";
import { AnalysisView, type AnalysisDto } from "@/components/analysis/analysis-view";
import { requireUser } from "@/server/auth/session";
import { getOwnedAnalysis } from "@/server/services/analysis-service";

export const metadata: Metadata = { title: "Analysis" };

export default async function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const parsed = idSchema.safeParse((await params).id);
  if (!parsed.success) notFound();

  let analysis;
  try {
    analysis = await getOwnedAnalysis(user.id, parsed.data);
  } catch (err) {
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }

  const initial: AnalysisDto = JSON.parse(
    JSON.stringify({
      id: analysis.id,
      status: analysis.status,
      stage: analysis.stage,
      progress: analysis.progress,
      mode: analysis.mode,
      analyzerVersion: analysis.analyzerVersion,
      commitSha: analysis.commitSha,
      error: analysis.error,
      summary: analysis.summary,
      scoreBreakdown: analysis.scoreBreakdown,
      createdAt: analysis.createdAt,
      startedAt: analysis.startedAt,
      finishedAt: analysis.finishedAt,
      repository: analysis.repository,
    }),
  );
  return <AnalysisView initial={initial} />;
}
