import type { Metadata } from "next";
import Link from "next/link";
import { FileArchive, FlaskConical, FolderGit2, Plus } from "lucide-react";
import { gradeFor } from "@pd/analyzer/scoring";
import { GRADE_TONE } from "@/components/analysis/labels";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { requireUser } from "@/server/auth/session";
import { listRepositories } from "@/server/services/analysis-service";

export const metadata: Metadata = { title: "Repositories" };

const SOURCE_ICON = { GITHUB: FolderGit2, GITLAB: FolderGit2, ZIP: FileArchive, DEMO: FlaskConical } as const;

export default async function DashboardPage() {
  const user = await requireUser();
  const repos = await listRepositories(user.id);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
          <p className="mt-1 text-sm text-muted-foreground">Every repository you have analysed, with its latest run.</p>
        </div>
        <Button asChild>
          <Link href="/new">
            <Plus /> New analysis
          </Link>
        </Button>
      </div>

      {repos.length === 0 ? (
        <Card className="grid place-items-center px-6 py-16 text-center">
          <h2 className="font-medium">No repositories yet</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            Analyse a public GitHub or GitLab repository, or upload a ZIP of your project.
          </p>
          <Button asChild className="mt-5">
            <Link href="/new">Analyze a repository</Link>
          </Button>
        </Card>
      ) : (
        <Card className="divide-y overflow-hidden">
          {repos.map((repo) => {
            const Icon = SOURCE_ICON[repo.source];
            const latest = repo.analyses[0];
            const title = repo.owner ? `${repo.owner}/${repo.name}` : repo.name;
            const body = (
              <div className="flex items-center gap-4 px-5 py-4">
                <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
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
              <Link key={repo.id} href={`/analysis/${latest.id}`} className="block transition-colors hover:bg-muted/50">
                {body}
              </Link>
            ) : (
              <div key={repo.id}>{body}</div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
