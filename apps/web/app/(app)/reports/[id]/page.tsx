import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, idSchema } from "@pd/shared";
import { ReportView, type ReportDto } from "@/components/reports/report-view";
import { requireUser } from "@/server/auth/session";
import { findReport } from "@/server/services/report-service";

export const metadata: Metadata = { title: "Report" };

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const parsed = idSchema.safeParse((await params).id);
  if (!parsed.success) notFound();
  let report;
  try {
    report = await findReport(user.id, parsed.data);
  } catch (err) {
    // Other users' reports are "not found", like everything else.
    if (err instanceof AppError && err.code === "NOT_FOUND") notFound();
    throw err;
  }
  const dto: ReportDto = JSON.parse(JSON.stringify(report));
  return (
    <div className="space-y-3">
      <Link href="/reports" className="text-sm text-muted-foreground hover:text-foreground">
        ← All reports
      </Link>
      <ReportView report={dto} />
    </div>
  );
}
