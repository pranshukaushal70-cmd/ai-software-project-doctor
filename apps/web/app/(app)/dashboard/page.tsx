import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, FileArchive, FlaskConical, FolderGit2, FolderSearch, Loader2, Plus, XCircle } from "lucide-react";
import { gradeFor } from "@pd/analyzer/scoring";
import { GRADE_TONE } from "@/components/analysis/labels";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { listRepositories } from "@/server/services/analysis-service";

export const metadata: Metadata = { title: "Repositories" };

const SOURCE_ICON = { GITHUB: FolderGit2, GITLAB: FolderGit2, ZIP: FileArchive, DEMO: FlaskConical } as const;

/**
 * Counts over each listed repository's latest analysis, exactly as stored. They describe the
 * list below (which shows the most recently updated repositories), so they never claim more.
 */
function Summary({ statuses, total }: { statuses: string[]; total: number }) {
  const count = (...s: string[]) => statuses.filter((x) => s.includes(x)).length;
  const items = [
    { label: "Repositories", value: total, icon: FolderGit2, tone: "text-primary" },
    { label: "Completed", value: count("COMPLETED"), icon: CheckCircle2, tone: "text-ok" },
    { label: "In progress", value: count("QUEUED", "RUNNING"), icon: Loader2, tone: "text-primary" },
    { label: "Failed", value: count("FAILED"), icon: XCircle, tone: "text-sev-critical" },
  ];
  return (
    <div className="mb-6">
      {/* A labelled list, value before label as shown, so each tile reads "3 Completed". */}
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-labelledby="summary-caption">
        {items.map(({ label, value, icon: Icon, tone }) => (
          <li key={label}>
            <Card className="flex items-center gap-3 px-4 py-3">
              <Icon className={`size-5 shrink-0 ${tone}`} aria-hidden />
              <div className="flex min-w-0 flex-col">
                <span className="text-xl font-semibold tabular-nums">{value}</span>
                <span className="text-xs leading-tight text-muted-foreground">{label}</span>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <p id="summary-caption" className="mt-2 text-xs text-muted-foreground">
        Status of the latest analysis of each repository listed below.
      </p>
    </div>
  );
}

export default async function DashboardPage() {
  const user = await requireUser();
  const repos = await listRepositories(user.id);

  return (
    <div>
      <PageHeader
        icon={FolderGit2}
        title="Repositories"
        description="Every repository you have analysed, with its latest run."
        className="mb-6"
        actions={
          <Button asChild>
            <Link href="/new">
              <Plus /> New analysis
            </Link>
          </Button>
        }
      />

      {repos.length === 0 ? (
        <EmptyState
          icon={FolderSearch}
          title="No repositories yet"
          action={
            <Button asChild>
              <Link href="/new">Analyze a repository</Link>
            </Button>
          }
        >
          Analyse a public GitHub or GitLab repository, or upload a ZIP of your project.
        </EmptyState>
      ) : (
        <>
        <Summary total={repos.length} statuses={repos.flatMap((r) => (r.analyses[0] ? [r.analyses[0].status] : []))} />
        <Card className="divide-y overflow-hidden">
          {repos.map((repo) => {
            const Icon = SOURCE_ICON[repo.source];
            const latest = repo.analyses[0];
            const title = repo.owner ? `${repo.owner}/${repo.name}` : repo.name;
            const body = (
              <div className="flex items-center gap-4 px-5 py-4">
                <Icon className="size-5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{title}</div>
                  <div className="text-xs text-muted-foreground">
                    {repo.branch ? `${repo.branch} · ` : ""}
                    {latest ? `Last analysed ${formatDate(latest.createdAt)}` : "Never analysed"}
                  </div>
                </div>
                {latest?.healthScore != null && (
                  <Badge tone={GRADE_TONE[gradeFor(latest.healthScore)]} title="Health score of the latest analysis">
                    {latest.healthScore} · {gradeFor(latest.healthScore)}
                  </Badge>
                )}
                {latest && <StatusBadge status={latest.status} />}
              </div>
            );
            return latest ? (
              <Link key={repo.id} href={`/analysis/${latest.id}`} className="group block transition-colors hover:bg-muted/50 focus-visible:bg-muted/50">
                {body}
              </Link>
            ) : (
              <div key={repo.id}>{body}</div>
            );
          })}
        </Card>
        </>
      )}
    </div>
  );
}
