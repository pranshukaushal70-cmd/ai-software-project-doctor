import Link from "next/link";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";
import type { ReportOutcomeName, ReportStatusName, ReportTypeName } from "@pd/shared/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { cn, formatDate } from "@/lib/utils";
import { OUTCOME, REPORT_STATUS, REPORT_TYPE } from "./labels";

export interface ReportListItemDto {
  id: string;
  type: ReportTypeName;
  status: ReportStatusName;
  outcome: ReportOutcomeName;
  title: string;
  summary: string;
  errorCount: number;
  warningCount: number;
  generatedAt: string;
  repository: { name: string; owner: string | null };
}

export interface ReportListDto {
  items: ReportListItemDto[];
  total: number;
  page: number;
  pages: number;
}

const FILTERS: Array<{ label: string; type: ReportTypeName | null }> = [
  { label: "All", type: null },
  { label: "Analysis", type: "ANALYSIS" },
  { label: "Plan", type: "PLAN" },
  { label: "Run", type: "RUN" },
];

const href = (type: ReportTypeName | null, page = 1) => {
  const q = new URLSearchParams();
  if (type) q.set("type", type);
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `/reports?${s}` : "/reports";
};

/** The user's reports, newest first. Statuses and results are shown as generated; nothing is recomputed here. */
export function ReportList({ list, type, error }: { list: ReportListDto | null; type: ReportTypeName | null; error?: string | null }) {
  return (
    <div className="space-y-4">
      <nav className="inline-flex flex-wrap gap-1 rounded-lg border bg-card p-1" aria-label="Report type">
        {FILTERS.map((f) => (
          <Link
            key={f.label}
            href={href(f.type)}
            aria-current={f.type === type ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
              f.type === type && "bg-primary/12 text-foreground ring-1 ring-primary/40",
            )}
          >
            {f.label}
          </Link>
        ))}
      </nav>
      {error ? (
        <Notice tone="error" role="alert" title="Reports could not be loaded" className="px-4 py-4">
          {error}
        </Notice>
      ) : !list || list.items.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No reports yet"
          action={
            <Button asChild variant="outline">
              <Link href="/planner">Open the planner</Link>
            </Button>
          }
        >
          Generate a report from an analysis page, or from a plan or run on the Planner page. A report records what the Project Doctor found, planned, changed and tested.
        </EmptyState>
      ) : (
        <>
          <Card className="divide-y overflow-hidden">
            {list.items.map((r) => {
              const outcome = OUTCOME[r.outcome];
              return (
                <Link key={r.id} href={`/reports/${r.id}`} className="group block min-w-0 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge>{REPORT_TYPE[r.type]}</Badge>
                    <Badge tone={outcome.tone}>{outcome.label}</Badge>
                    {r.status === "PARTIAL" && <Badge tone={REPORT_STATUS.PARTIAL.tone}>Partial</Badge>}
                    {r.errorCount > 0 && <Badge tone="critical">{r.errorCount} errors</Badge>}
                    {r.warningCount > 0 && <Badge tone="medium">{r.warningCount} warnings</Badge>}
                    <span className="ml-auto text-xs text-muted-foreground">{formatDate(r.generatedAt)}</span>
                  </div>
                  <p className="mt-1 truncate font-medium transition-colors group-hover:text-primary" title={r.title}>
                    {r.title}
                  </p>
                  <p className="line-clamp-2 text-sm break-words text-muted-foreground">{r.summary}</p>
                </Link>
              );
            })}
          </Card>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {list.total} reports · page {list.page} of {list.pages}
            </span>
            <span className="flex gap-2">
              {list.page > 1 && (
                <Button asChild variant="outline" size="sm">
                  <Link href={href(type, list.page - 1)}>
                    <ChevronLeft aria-hidden /> Previous
                  </Link>
                </Button>
              )}
              {list.page < list.pages && (
                <Button asChild variant="outline" size="sm">
                  <Link href={href(type, list.page + 1)}>
                    Next <ChevronRight aria-hidden />
                  </Link>
                </Button>
              )}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
