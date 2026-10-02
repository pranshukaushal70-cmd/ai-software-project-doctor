import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompletedAnalysis, type AnalysisDto, type TabId } from "@/components/analysis/analysis-view";
import { ModulesNotice, ScanOverview } from "@/components/analysis/scan-overview";
import type { CodeMetricsDto, ScanSummaryDto } from "@/components/analysis/types";
import { architectureSummary, dependencySummary, scanSummary } from "./ui-fixtures";

/** Only the finding counts of code metrics are read by the tab bar. */
const codeMetrics = { findings: { stored: 5 } } as unknown as CodeMetricsDto;

const analysis = (summary: ScanSummaryDto, analyzerVersion = "0.4.0"): AnalysisDto => ({
  id: "a1",
  status: "COMPLETED",
  stage: "COMPLETED",
  progress: 100,
  mode: "LOCAL_ONLY",
  analyzerVersion,
  commitSha: null,
  error: null,
  summary,
  createdAt: "2026-10-01T00:00:00Z",
  startedAt: null,
  finishedAt: null,
  repository: { id: "r1", name: "shop", owner: null, url: null, source: "ZIP", branch: null },
});

const render = (summary: ScanSummaryDto, initialTab: TabId, version?: string) =>
  renderToStaticMarkup(createElement(CompletedAnalysis, { analysis: analysis(summary, version), initialTab }));

const full = scanSummary({ codeMetrics, dependencies: dependencySummary(), architecture: architectureSummary() });

describe("analysis tabs", () => {
  it("adds Dependencies and Architecture tabs with vulnerability and cycle counts", () => {
    const html = render(full, "overview");
    expect(html).toMatch(/id="tab-dependencies"[^>]*>Dependencies<span[^>]*bg-sev-critical[^>]*>1<\/span>/);
    expect(html).toMatch(/id="tab-architecture"[^>]*>Architecture<span[^>]*>1<\/span>/);
    // All findings counts every module's stored findings: 5 code + 2 dependency + 1 architecture.
    expect(html).toMatch(/id="tab-findings"[^>]*>All findings<span[^>]*>8<\/span>/);
  });

  it("renders the dependency and architecture panels in their tabs", () => {
    expect(render(full, "dependencies")).toContain("Vulnerable packages");
    expect(render(full, "architecture")).toContain("Import graph");
  });

  it("explains that older analyses have no dependency or architecture results", () => {
    const old = scanSummary({ modulesRun: ["repository-scan", "code-metrics", "security"], codeMetrics });
    expect(render(old, "dependencies", "0.3.0")).toContain("produced by analyzer v0.3.0, before dependency analysis existed");
    expect(render(old, "architecture", "0.3.0")).toContain("before architecture analysis existed");
    expect(render(old, "overview", "0.3.0")).not.toMatch(/id="tab-dependencies"[^>]*>Dependencies<span/);
  });
});

describe("ModulesNotice", () => {
  const notice = (modulesRun: string[]) => renderToStaticMarkup(createElement(ModulesNotice, { modulesRun }));

  it("lists every module that ran and no longer calls them upcoming", () => {
    const html = notice(full.modulesRun);
    expect(html).toContain("<strong>dependency analysis</strong>");
    expect(html).toContain("<strong>architecture analysis</strong>");
    expect(html).toContain("Dependencies and Architecture tabs");
    expect(html).not.toContain("upcoming");
    expect(html).not.toContain("earlier analyzer version");
    expect(html).toContain("Git history insights and an overall health score are added in later analyzer versions");
  });

  it("names the modules an older analysis did not run", () => {
    const html = notice(["repository-scan", "code-metrics"]);
    expect(html).toContain("without security analysis, dependency analysis and architecture analysis");
  });

  it("is what the overview shows", () => {
    const html = renderToStaticMarkup(createElement(ScanOverview, { analysisId: "a1", summary: full }));
    expect(html).toContain("<strong>architecture analysis</strong>");
    expect(html).not.toContain("upcoming analyzer versions");
  });
});
