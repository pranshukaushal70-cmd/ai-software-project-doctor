import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HealthPanel, HealthScoreCard } from "@/components/analysis/health-panel";
import { PracticesPanel } from "@/components/analysis/practices-panel";
import { healthScore, practicesSummary } from "./ui-fixtures";

const panel = (health = healthScore()) => renderToStaticMarkup(createElement(HealthPanel, { health, analyzerVersion: "0.5.0" }));

describe("HealthPanel", () => {
  it("shows the score, grade and every deduction with how it was computed", () => {
    const html = panel();
    expect(html).toContain(">62<");
    expect(html).toContain("Grade C");
    expect(html).toContain("No automated tests");
    expect(html).toContain("Fixed penalty of 80 points (testing/no-tests).");
    expect(html).toContain("15 points each, at most 45.");
    expect(html).toContain("Weight 25 (25% of the overall score)");
    expect(html).toContain("No deductions.");
  });

  it("lists dimensions that do not apply, with the reason, and the caveats", () => {
    const html = panel();
    expect(html).toContain("Not scored");
    expect(html).toContain("No HTTP endpoints were detected.");
    expect(html).toContain("No coverage report was found");
    expect(html).toContain("not certifications");
    expect(html).toContain("Scoring v1.0, analyzer v0.5.0");
  });

  it("explains a score capped by open security findings", () => {
    const capped = healthScore({ score: 49, grade: "F", weightedScore: 77, cap: { max: 49, reason: "1 critical security finding (secrets or insecure code) limit the score to 49 until fixed or triaged." } });
    const html = panel(capped);
    expect(html).toContain("The weighted score is 77, but 1 critical security finding");
    expect(html).toContain("Grade F");
    expect(renderToStaticMarkup(createElement(HealthScoreCard, { health: capped }))).toContain("Capped: 1 critical security finding");
  });

  it("shows the weakest dimensions on the overview card", () => {
    const html = renderToStaticMarkup(createElement(HealthScoreCard, { health: healthScore() }));
    expect(html.indexOf("Testing")).toBeLessThan(html.indexOf("Security"));
    expect(html).not.toContain("Architecture"); // 100: nothing to improve
    expect(html).toMatch(/role="meter" aria-label="Testing score" aria-valuenow="20"/);
  });
});

describe("PracticesPanel", () => {
  const render = (over = {}) => renderToStaticMarkup(createElement(PracticesPanel, { analysisId: "a1", summary: practicesSummary(over) }));

  it("renders the API, database, testing and documentation sections", () => {
    const html = render();
    expect(html).toContain("2 endpoints in Express");
    expect(html).toContain("0 of 1 state-changing endpoints show an authentication check");
    expect(html).toContain("/products/:id");
    expect(html).toContain("src/server.js:12");
    expect(html).toContain("2 foreign keys without an index");
    expect(html).toContain("Test-to-code ratio 0.03");
    expect(html).toContain("No committed coverage report");
    expect(html).toContain("No CI configuration");
    expect(html).toContain("1 of 3 environment variables documented");
    expect(html).toContain("SMTP_HOST, STRIPE_SECRET_KEY");
    expect(html).toContain("0 of 1 relative links resolve");
    expect(html).toContain("API, database, testing and documentation findings");
  });

  it("states when nothing was detected instead of showing empty tables", () => {
    const html = render({
      api: { ...practicesSummary().api, endpoints: 0, list: [], frameworks: [], mutating: 0, mutatingWithoutAuth: 0 },
      database: { ...practicesSummary().database, detected: false },
    });
    expect(html).toContain("No HTTP endpoints were detected");
    expect(html).toContain("No database, ORM or schema was detected.");
    expect(html).not.toContain("<th");
  });

  it("shows coverage only from a committed report", () => {
    const html = render({ testing: { ...practicesSummary().testing, coverage: { path: "coverage/lcov.info", format: "lcov", linePercent: 81.5 } } });
    expect(html).toContain("81.5% line coverage (lcov)");
    expect(html).toContain("coverage/lcov.info");
  });
});
