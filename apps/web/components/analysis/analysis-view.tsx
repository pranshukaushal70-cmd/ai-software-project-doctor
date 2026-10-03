"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { ANALYSIS_STAGES } from "@pd/shared/constants";
import { GenerateReportButton } from "../reports/generate-report-button";
import { StatusBadge } from "../status-badge";
import { Card, CardContent } from "../ui/card";
import { api } from "@/lib/api-client";
import { cn, formatDate } from "@/lib/utils";
import { ArchitecturePanel } from "./architecture-panel";
import { CodeMetrics } from "./code-metrics";
import { DependenciesPanel } from "./dependencies-panel";
import { FindingsList } from "./findings-list";
import { HealthPanel, HealthScoreCard } from "./health-panel";
import { IntelligencePanel } from "./intelligence-panel";
import { PracticesPanel } from "./practices-panel";
import { ProgressPanel } from "./progress-panel";
import { ScanOverview } from "./scan-overview";
import { SecurityPanel } from "./security-panel";
import type { HealthScoreDto, ScanSummaryDto } from "./types";

export interface AnalysisDto {
  id: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  stage: (typeof ANALYSIS_STAGES)[number]["id"];
  progress: number;
  mode: "LOCAL_ONLY" | "AI";
  analyzerVersion: string;
  commitSha: string | null;
  error: string | null;
  summary: ScanSummaryDto | null;
  /** Explainable health score; present from analyzer v0.5.0 on. */
  scoreBreakdown?: HealthScoreDto | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  repository: { id: string; name: string; owner: string | null; url: string | null; source: string; branch: string | null };
}

const POLL_MS = 2000;

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "code", label: "Code quality" },
  { id: "security", label: "Security" },
  { id: "dependencies", label: "Dependencies" },
  { id: "architecture", label: "Architecture" },
  { id: "practices", label: "Practices" },
  { id: "health", label: "Health" },
  { id: "intelligence", label: "Intelligence" },
  { id: "findings", label: "All findings" },
] as const;
export type TabId = (typeof TABS)[number]["id"];

function tabFromHash(): TabId {
  if (typeof window === "undefined") return "overview";
  const id = window.location.hash.slice(1);
  return TABS.some((t) => t.id === id) ? (id as TabId) : "overview";
}

/** Shown on a tab whose module did not exist yet in the analyzer version that produced this analysis. */
function OlderAnalyzerNotice({ version, module, action }: { version: string; module: string; action: string }) {
  return (
    <Card>
      <CardContent className="pt-5 text-sm text-muted-foreground">
        This analysis was produced by analyzer v{version}, before {module} existed. Run a new analysis of this repository to {action}.
      </CardContent>
    </Card>
  );
}

function TabCount({ value, alert }: { value: number; alert?: boolean }) {
  return (
    <span className={cn("ml-1.5 rounded-full px-1.5 py-0.5 text-xs tabular-nums", alert ? "bg-sev-critical/12 text-sev-critical" : "bg-muted")}>
      {value}
    </span>
  );
}

export function CompletedAnalysis({ analysis, initialTab = "overview" }: { analysis: AnalysisDto; initialTab?: TabId }) {
  const [tab, setTab] = useState<TabId>(initialTab);
  useEffect(() => setTab((t) => (window.location.hash ? tabFromHash() : t)), []);
  const select = (id: TabId) => {
    setTab(id);
    window.history.replaceState(null, "", `#${id}`);
  };
  const summary = analysis.summary!;
  const code = summary.codeMetrics;
  const security = summary.security;
  const dependencies = summary.dependencies;
  const architecture = summary.architecture;
  const practices = summary.practices;
  const intelligence = summary.intelligence;
  const health = analysis.scoreBreakdown ?? null;
  const findingCount = code
    ? code.findings.stored + (security?.findings.stored ?? 0) + (dependencies?.findings.stored ?? 0) + (architecture?.findings.stored ?? 0) + (practices?.findings.stored ?? 0)
    : undefined;
  const securityCount = security?.totals.findings;
  const vulnerableCount = dependencies?.totals.vulnerable;
  const cycleCount = architecture?.totals.cycles;

  return (
    <div className="flex flex-col gap-6">
      {/* Scrolls on its own on narrow screens instead of widening the page. */}
      <div role="tablist" aria-label="Analysis sections" className="flex gap-1 overflow-x-auto border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            onClick={() => select(t.id)}
            className={cn(
              "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
            {t.id === "findings" && findingCount !== undefined && <TabCount value={findingCount} />}
            {t.id === "security" && securityCount !== undefined && securityCount > 0 && (
              <TabCount value={securityCount} alert={security!.totals.secrets > 0} />
            )}
            {t.id === "dependencies" && vulnerableCount !== undefined && vulnerableCount > 0 && (
              <TabCount value={vulnerableCount} alert={dependencies!.totals.bySeverity.CRITICAL + dependencies!.totals.bySeverity.HIGH > 0} />
            )}
            {t.id === "architecture" && cycleCount !== undefined && cycleCount > 0 && <TabCount value={cycleCount} />}
            {t.id === "health" && health && <TabCount value={health.score} alert={health.grade === "D" || health.grade === "F"} />}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "overview" && (
          <div className="flex flex-col gap-6">
            {health && <HealthScoreCard health={health} onDetails={() => select("health")} />}
            <ScanOverview analysisId={analysis.id} summary={summary} />
          </div>
        )}
        {tab !== "overview" && !code && (
          <OlderAnalyzerNotice version={analysis.analyzerVersion} module="code metrics" action="see code quality and findings" />
        )}
        {tab === "code" && code && <CodeMetrics analysisId={analysis.id} metrics={code} />}
        {tab === "security" && code && !security && (
          <OlderAnalyzerNotice version={analysis.analyzerVersion} module="security analysis" action="check it for secrets and insecure code" />
        )}
        {tab === "security" && security && <SecurityPanel analysisId={analysis.id} security={security} />}
        {tab === "dependencies" && code && !dependencies && (
          <OlderAnalyzerNotice version={analysis.analyzerVersion} module="dependency analysis" action="check its dependencies for known vulnerabilities" />
        )}
        {tab === "dependencies" && dependencies && <DependenciesPanel analysisId={analysis.id} summary={dependencies} />}
        {tab === "architecture" && code && !architecture && (
          <OlderAnalyzerNotice version={analysis.analyzerVersion} module="architecture analysis" action="map its import graph and find cycles" />
        )}
        {tab === "architecture" && architecture && <ArchitecturePanel analysisId={analysis.id} summary={architecture} />}
        {tab === "practices" && code && !practices && (
          <OlderAnalyzerNotice version={analysis.analyzerVersion} module="API, database, testing and documentation analysis" action="check its API, database, tests and documentation" />
        )}
        {tab === "practices" && practices && <PracticesPanel analysisId={analysis.id} summary={practices} />}
        {tab === "health" && code && !health && (
          <OlderAnalyzerNotice version={analysis.analyzerVersion} module="the health score" action="get an explainable health score" />
        )}
        {tab === "health" && health && <HealthPanel health={health} analyzerVersion={analysis.analyzerVersion} />}
        {tab === "intelligence" && code && !intelligence && (
          <OlderAnalyzerNotice version={analysis.analyzerVersion} module="the repository index" action="index its symbols, dependencies and call graph" />
        )}
        {tab === "intelligence" && intelligence && <IntelligencePanel analysisId={analysis.id} summary={intelligence} />}
        {tab === "findings" && code && <FindingsList analysisId={analysis.id} />}
      </div>
    </div>
  );
}

export function AnalysisView({ initial }: { initial: AnalysisDto }) {
  const [analysis, setAnalysis] = useState(initial);
  const [pollError, setPollError] = useState(false);
  const active = analysis.status === "QUEUED" || analysis.status === "RUNNING";

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const next = await api<AnalysisDto>(`/api/analysis/${initial.id}`);
        if (!cancelled) {
          setAnalysis(next);
          setPollError(false);
        }
      } catch {
        if (!cancelled) setPollError(true);
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, initial.id]);

  const repo = analysis.repository;
  const title = repo.owner ? `${repo.owner}/${repo.name}` : repo.name;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
            <StatusBadge status={analysis.status} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {repo.url && (
              <a href={repo.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-foreground">
                {repo.url.replace("https://", "")} <ExternalLink className="size-3" />
              </a>
            )}
            {repo.branch && <span>branch {repo.branch}</span>}
            {analysis.commitSha && <span className="font-mono">{analysis.commitSha.slice(0, 10)}</span>}
            <span>analyzer v{analysis.analyzerVersion}</span>
            <span>{formatDate(analysis.createdAt)}</span>
          </div>
        </div>
        {!active && <GenerateReportButton type="ANALYSIS" subjectId={analysis.id} />}
      </div>

      {active && <ProgressPanel stage={analysis.stage} progress={analysis.progress} connectionLost={pollError} />}

      {analysis.status === "FAILED" && (
        <Card className="border-sev-critical/30">
          <CardContent className="flex items-start gap-3 pt-5">
            <AlertTriangle className="mt-0.5 size-5 text-sev-critical" />
            <div>
              <div className="font-medium">Analysis failed</div>
              <p className="text-sm text-muted-foreground">{analysis.error ?? "An unknown error occurred."}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {analysis.status === "COMPLETED" && analysis.summary && <CompletedAnalysis analysis={analysis} />}
    </div>
  );
}
