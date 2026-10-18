import type { Metadata } from "next";
import { loadLimits } from "@pd/shared";
import { ScanSearch } from "lucide-react";
import { DemoAnalysisCard } from "@/components/demo-analysis-card";
import { NewAnalysisForm } from "@/components/new-analysis-form";
import { PageHeader } from "@/components/page-header";

export const metadata: Metadata = { title: "New analysis" };

export default function NewAnalysisPage() {
  const maxUploadMb = Math.round(loadLimits().maxUploadBytes / 1024 / 1024);
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader icon={ScanSearch} title="New analysis" description="Point the doctor at a repository. Code is analysed statically and is never executed." />
      <NewAnalysisForm maxUploadMb={maxUploadMb} />
      <DemoAnalysisCard />
    </div>
  );
}
