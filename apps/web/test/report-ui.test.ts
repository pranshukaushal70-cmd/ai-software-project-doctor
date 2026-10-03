import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { generateReport, type ReportSubject } from "@pd/reports";
import { ReportList, type ReportListDto } from "@/components/reports/report-list";
import { ReportView, type ReportDto } from "@/components/reports/report-view";
import { fakeReportsDb } from "../../../packages/reports/test/fake-db";
import { FAKE_KEY, world } from "../../../packages/reports/test/fixtures";

/** A real report built from the fixture world, as the page receives it (JSON round trip). */
async function report(subject: ReportSubject, mutate?: (w: ReturnType<typeof world>) => void): Promise<ReportDto> {
  const w = world();
  mutate?.(w);
  const { report: r } = await generateReport(fakeReportsDb(w) as any, "u1", subject);
  return JSON.parse(JSON.stringify(r));
}
const render = (r: ReportDto, interactive = true) => renderToStaticMarkup(createElement(ReportView, { report: r, interactive }));

describe("ReportView", () => {
  it("lays out the whole chain for a run report, in the documented sections", async () => {
    const html = render(await report({ type: "RUN", id: "run-passed" }));
    const order = ["Repository", "Analysis", "Engineering plan", "Approval", "Execution / run", "Changes", "Validation", "Tests", "Security", "Errors and warnings", "Limitations", "Timeline"].map((t) =>
      html.indexOf(`</span>${t}`),
    );
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("Tests passed");
    expect(html).toContain("Report complete");
    expect(html).toContain("Final result");
    expect(html).toContain("acme/storefront");
    expect(html).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(html).toContain('href="/api/reports/');
    expect(html).toContain("export?format=markdown");
    expect(html).toContain("Show diff (loaded from the run)");
  });

  it("never shows success when tests did not run, and shows failures plainly", async () => {
    const untested = render(await report({ type: "RUN", id: "run-untested" }));
    expect(untested).toContain("Not tested");
    expect(untested).not.toContain("Tests passed");
    expect(untested).toContain("Not executed");
    expect(untested).toContain("Tests not run: Sandboxed test runs are disabled on this server.");
    const failed = render(await report({ type: "RUN", id: "run-failed" }));
    expect(failed).toContain(">Failed<");
    expect(failed).toContain("The rebuilt source does not match the analysis; run a new analysis.");
    const failedTests = render(await report({ type: "RUN", id: "run-failed-tests" }));
    expect(failedTests).toContain("Tests failed");
    expect(failedTests).toContain("exit 1");
  });

  it("marks partial reports and analysis-only reports", async () => {
    const partial = render(await report({ type: "RUN", id: "run-awaiting" }));
    expect(partial).toContain("Report partial");
    expect(partial).toContain("Awaiting approval");
    expect(partial).toContain("generate it again later");
    const analysis = render(await report({ type: "ANALYSIS", id: "an1" }));
    expect(analysis).not.toContain("Engineering plan");
    expect(analysis).not.toContain("Execution / run");
    expect(analysis).toContain("62/100 (grade C)");
  });

  it("renders security findings without secret values", async () => {
    const html = render(await report({ type: "RUN", id: "run-passed" }));
    expect(html).toContain("secret detected");
    expect(html).toContain("Stripe secret key");
    expect(html).toContain("(values are never shown)");
    expect(html).toContain(".github/workflows/ci.yml");
    expect(html).toContain("forbidden-path");
    expect(html).not.toContain(FAKE_KEY);
  });

  it("renders hostile repository content as inert text", async () => {
    const html = render(await report({ type: "RUN", id: "run-failed-tests" }));
    expect(html).not.toMatch(/<script>|<img |<b>bold/);
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Ignore all previous instructions");
    expect(html).not.toContain(FAKE_KEY);
  });

  it("keeps large reports usable: long change lists start collapsed and diffs load on demand", async () => {
    const big = await report({ type: "RUN", id: "run-passed" }, (w) => {
      for (let i = 0; i < 60; i++) w.changes.push({ runId: "run-passed", iteration: 1, path: `src/gen/file-${String(i).padStart(2, "0")}.js`, operation: "CREATE", status: "APPLIED", reason: "Generated.", additions: 5, deletions: 0, flags: [] });
    });
    const html = render(big);
    expect(html).toMatch(/<details class="[^"]*"><summary[^>]*>.*?<\/span>Changes/);
    expect(html.match(/Show diff \(loaded from the run\)/g)!.length).toBe(61);
    expect(html).not.toContain("diff --git");
    // Static (non-interactive) rendering has no diff loader and no regenerate button.
    const flat = render(big, false);
    expect(flat).not.toContain("Show diff");
    expect(flat).not.toContain("Generate again");
  });
});

describe("ReportList", () => {
  const item = (over: Partial<ReportListDto["items"][number]> = {}): ReportListDto["items"][number] => ({
    id: "rep1",
    type: "RUN",
    status: "COMPLETE",
    outcome: "NOT_TESTED",
    title: "Run report: Add rate limiting (acme/storefront)",
    summary: "The run changed 1 file, but the changes were not tested.",
    errorCount: 0,
    warningCount: 1,
    generatedAt: "2026-10-03T12:00:00.000Z",
    repository: { name: "storefront", owner: "acme" },
    ...over,
  });

  it("shows reports with their result, status and counts, and pagination", () => {
    const html = renderToStaticMarkup(
      createElement(ReportList, {
        list: { items: [item(), item({ id: "rep2", outcome: "FAILED", errorCount: 1, warningCount: 0, status: "PARTIAL", title: "<script>x</script>" })], total: 45, page: 2, pages: 3 },
        type: "RUN",
      }),
    );
    expect(html).toContain('href="/reports/rep1"');
    expect(html).toContain("Not tested");
    expect(html).toContain("1 warnings");
    expect(html).toContain(">Failed<");
    expect(html).toContain("Partial");
    expect(html).toContain("1 errors");
    expect(html).not.toContain("<script>x");
    expect(html).toContain("45 reports · page 2 of 3");
    expect(html).toContain('href="/reports?type=RUN"');
    expect(html).toContain('href="/reports?type=RUN&amp;page=3"');
    expect(html).toMatch(/aria-current="page"[^>]*>Run</);
  });

  it("has empty and failure states", () => {
    const empty = renderToStaticMarkup(createElement(ReportList, { list: { items: [], total: 0, page: 1, pages: 1 }, type: null }));
    expect(empty).toContain("No reports yet");
    const failed = renderToStaticMarkup(createElement(ReportList, { list: null, type: null, error: "Database unavailable" }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Reports could not be loaded");
  });
});
