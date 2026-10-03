import type { Metadata } from "next";
import { idSchema } from "@pd/shared";
import { PlannerView } from "@/components/planner/planner-view";
import { requireUser } from "@/server/auth/session";
import { listPlannableAnalyses } from "@/server/services/engineering-service";

export const metadata: Metadata = { title: "Engineering planner" };

export default async function PlannerPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const user = await requireUser();
  const requested = idSchema.safeParse((await searchParams).analysisId);
  const analyses = await listPlannableAnalyses(user.id);
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Engineering planner</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        Describe a change and get a plan grounded in the repository index. Every claim is marked verified, inferred or unknown and cites the evidence it rests on; references to files
        or symbols that do not exist are flagged. Planning changes nothing; once you approve a plan, the code engine can propose the change as a
        reviewable diff and, with a second approval, run the tests in an isolated sandbox. Nothing is committed or pushed.
      </p>
      <PlannerView analyses={analyses} initialAnalysisId={requested.success ? requested.data : null} />
    </div>
  );
}
