import "server-only";
import { getPrisma } from "@pd/db";
import { AppError, type TriageInput } from "@pd/shared";

/**
 * Triage decisions are stored per repository and finding fingerprint (rule + path +
 * stable key). They label one specific finding across re-analyses of the same
 * repository; they never hide other findings and never apply to other repositories.
 */

async function findingOf(analysisId: string, findingId: string) {
  const finding = await getPrisma().finding.findFirst({
    where: { id: findingId, analysisId },
    select: { fingerprint: true, ruleId: true, file: { select: { path: true } } },
  });
  if (!finding) throw new AppError("NOT_FOUND", "Finding not found");
  return finding;
}

export async function setTriage(userId: string, analysis: { id: string; repositoryId: string }, findingId: string, input: TriageInput) {
  const finding = await findingOf(analysis.id, findingId);
  const data = {
    status: input.status,
    reason: input.reason ?? null,
    ruleId: finding.ruleId,
    path: finding.file?.path ?? null,
    createdById: userId,
  };
  return getPrisma().findingTriage.upsert({
    where: { repositoryId_fingerprint: { repositoryId: analysis.repositoryId, fingerprint: finding.fingerprint } },
    create: { repositoryId: analysis.repositoryId, fingerprint: finding.fingerprint, ...data },
    update: data,
    select: { status: true, reason: true, updatedAt: true },
  });
}

export async function clearTriage(analysis: { id: string; repositoryId: string }, findingId: string) {
  const finding = await findingOf(analysis.id, findingId);
  const { count } = await getPrisma().findingTriage.deleteMany({
    where: { repositoryId: analysis.repositoryId, fingerprint: finding.fingerprint },
  });
  return { cleared: count > 0 };
}
