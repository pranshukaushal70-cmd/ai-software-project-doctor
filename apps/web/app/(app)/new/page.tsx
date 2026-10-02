import type { Metadata } from "next";
import { loadLimits } from "@pd/shared";
import { DemoAnalysisCard } from "@/components/demo-analysis-card";
import { NewAnalysisForm } from "@/components/new-analysis-form";

export const metadata: Metadata = { title: "New analysis" };

export default function NewAnalysisPage() {
  const maxUploadMb = Math.round(loadLimits().maxUploadBytes / 1024 / 1024);
  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">New analysis</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Point the doctor at a repository. Code is analysed statically and is never executed.
      </p>
      <NewAnalysisForm maxUploadMb={maxUploadMb} />
      <DemoAnalysisCard />
    </div>
  );
}
