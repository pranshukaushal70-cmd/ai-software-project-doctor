import type { Metadata } from "next";
import { reportsQuerySchema } from "@pd/shared";
import { FileText } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ReportList, type ReportListDto } from "@/components/reports/report-list";
import { requireUser } from "@/server/auth/session";
import { findReports } from "@/server/services/report-service";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const user = await requireUser();
  const raw = await searchParams;
  // Unknown or malformed filters fall back to the unfiltered first page.
  const parsed = reportsQuerySchema.safeParse({ type: raw.type, page: raw.page });
  const query = parsed.success ? parsed.data : reportsQuerySchema.parse({});
  const list: ReportListDto = JSON.parse(JSON.stringify(await findReports(user.id, query)));
  return (
    <div>
      <PageHeader
        icon={FileText}
        title="Reports"
        className="mb-6"
        description="Snapshots of what the Project Doctor found, planned, changed, validated and tested, built from stored data. A report never changes after it is generated; secrets and code are never included."
      />
      <ReportList list={list} type={query.type ?? null} />
    </div>
  );
}
