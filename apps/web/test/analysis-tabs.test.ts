import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompletedAnalysis, type AnalysisDto, type TabId } from "@/components/analysis/analysis-view";
import { ModulesNotice, ScanOverview } from "@/components/analysis/scan-overview";
import type { CodeMetricsDto, ScanSummaryDto } from "@/components/analysis/types";
import type { HealthScoreDto } from "@/components/analysis/types";
import { architectureSummary, dependencySummary, healthScore, practicesSummary, scanSummary } from "./ui-fixtures";

/** Only the finding counts of code metrics are read by the tab bar. */
const codeMetrics = { findings: { stored: 5 } } as unknown as CodeMetricsDto;

const analysis = (summary: ScanSummaryDto, analyzerVersion = "0.4.0", scoreBreakdown: HealthScoreDto | null = null): AnalysisDto => ({
  id: "a1",
  status: "COMPLETED",
  stage: "COMPLETED",
  progress: 100,
  mode: "LOCAL_ONLY",
  analyzerVersion,
  commitSha: null,
  error: null,
  summary,
  scoreBreakdown,
  createdAt: "2026-10-01T00:00:00Z",
  startedAt: null,
  finishedAt: null,
  repository: { id: "r1", name: "shop", owner: null, url: null, source: "ZIP", branch: null },
});

const render = (summary: ScanSummaryDto, initialTab: TabId, version?: string, health: HealthScoreDto | null = null) =>
  renderToStaticMarkup(createElement(CompletedAnalysis, { analysis: analysis(summary, version, health), initialTab }));

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
    expect(html).toContain("Dependencies, Architecture, Practices, Health and Intelligence tabs");
    expect(html).not.toContain("upcoming");
    expect(html).not.toContain("earlier analyzer version");
    expect(html).toContain("Git history insights and AI recommendations are added in later analyzer versions");
  });

  it("names the modules an older analysis did not run", () => {
    const html = notice(["repository-scan", "code-metrics"]);
    expect(html).toContain("without security analysis, dependency analysis, architecture analysis, API, database, testing &amp; documentation analysis, health scoring and repository indexing");
  });

  it("lists the Phase 5 modules and their tabs when they ran", () => {
    const html = notice(full.modulesRun);
    expect(html).toContain("<strong>health scoring</strong>");
    expect(html).toContain("Practices, Health and Intelligence tabs");
    expect(html).not.toContain("earlier analyzer version");
  });

  it("is what the overview shows", () => {
    const html = renderToStaticMarkup(createElement(ScanOverview, { analysisId: "a1", summary: full }));
    expect(html).toContain("<strong>architecture analysis</strong>");
    expect(html).not.toContain("upcoming analyzer versions");
  });
});

describe("Practices and Health tabs", () => {
  const v5 = { ...full, practices: practicesSummary() };

  it("shows the score on the Health tab and as a card on the overview", () => {
    const overview = render(v5, "overview", "0.5.0", healthScore());
    expect(overview).toMatch(/id="tab-health"[^>]*>Health<span[^>]*>62<\/span>/);
    expect(overview).toContain("Health score");
    expect(overview).toContain("See how the score is calculated");
    // The weakest dimensions are listed first on the card.
    const card = overview.slice(overview.indexOf("Health score"));
    expect(card.indexOf("Testing")).toBeLessThan(card.indexOf("Security"));
    expect(render(v5, "health", "0.5.0", healthScore())).toContain("Score by dimension");
  });

  it("counts practice findings in All findings and renders the Practices panel", () => {
    // 5 code + 2 dependency + 1 architecture + 9 practices.
    expect(render(v5, "overview", "0.5.0", healthScore())).toMatch(/id="tab-findings"[^>]*>All findings<span[^>]*>17<\/span>/);
    expect(render(v5, "practices", "0.5.0", healthScore())).toContain("API, database, testing and documentation findings");
  });

  it("explains that analyses before v0.5.0 have no practices or score", () => {
    expect(render(full, "practices", "0.4.1")).toContain("before API, database, testing and documentation analysis existed");
    expect(render(full, "health", "0.4.1")).toContain("before the health score existed");
    expect(render(full, "overview", "0.4.1")).not.toContain("Health score");
  });
});
