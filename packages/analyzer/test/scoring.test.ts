import { describe, expect, it } from "vitest";
import type { FindingCategory, Severity } from "@pd/shared/constants";
import { computeHealthScore, gradeFor, SCORE_DIMENSIONS, scoringWeights, type ScoringInput } from "../src/scoring";

const ALL_PRESENT = { code: true, dependencies: true, architecture: true, api: true, database: true };
let seq = 0;
const finding = (category: FindingCategory, severity: Severity, ruleId = `${category.toLowerCase()}/rule`) => ({
  ruleId,
  category,
  severity,
  fingerprint: `fp${seq++}`,
});
const score = (over: Partial<ScoringInput> = {}) =>
  computeHealthScore({ findings: [], productionCodeLines: 1000, present: ALL_PRESENT, coverageMeasured: true, ...over });
const dim = (r: ReturnType<typeof score>, id: string) => r.dimensions.find((d) => d.id === id)!;

describe("health score", () => {
  it("is 100 (A) without findings, with every dimension applicable", () => {
    const r = score();
    expect(r).toMatchObject({ score: 100, grade: "A", excludedFindings: 0, caveats: [] });
    expect(r.dimensions.every((d) => d.applicable && d.score === 100 && d.factors.length === 0)).toBe(true);
    expect(r.dimensions.reduce((n, d) => n + d.effectiveWeight, 0)).toBeCloseTo(100, 0);
  });

  it("deducts per severity with a cap, and explains every deduction", () => {
    const r = score({ findings: [...Array.from({ length: 3 }, () => finding("SECRET", "CRITICAL")), finding("SECURITY", "HIGH"), finding("SECURITY", "INFO")] });
    const security = dim(r, "security");
    // 3 × 30 = 90, capped at 60; 1 × 15; INFO costs nothing.
    expect(security.factors).toEqual([
      { label: "3 critical findings", points: -60, detail: "30 points each, at most 60." },
      { label: "1 high finding", points: -15, detail: "15 points each, at most 45." },
    ]);
    expect(security).toMatchObject({ score: 25, findings: 5 });
    // Security weighs 25 of 100: 25 × 25 + 75 × 100 = 8125 → 81, but open critical findings cap the score at 49.
    expect(r).toMatchObject({ weightedScore: 81, score: 49, grade: "D" });
    expect(r.cap).toEqual({ max: 49, reason: "3 critical security findings (secrets or insecure code) limit the score to 49 until fixed or triaged." });
  });

  it("measures code quality and architecture findings per 1,000 lines, so large repositories are not punished for size", () => {
    const findings = Array.from({ length: 10 }, () => finding("CODE_QUALITY", "MEDIUM"));
    expect(dim(score({ findings, productionCodeLines: 1000 }), "codeQuality").score).toBe(70); // 60 → capped at 30
    expect(dim(score({ findings, productionCodeLines: 20_000 }), "codeQuality").score).toBe(97); // 6 × 10 ÷ 20 = 3
    expect(dim(score({ findings, productionCodeLines: 20_000 }), "codeQuality").factors[0]!.label).toBe("10 medium findings in 20k lines");
    // Security findings are absolute: a leaked key is as bad in a large repository.
    expect(dim(score({ findings: [finding("SECRET", "CRITICAL")], productionCodeLines: 20_000 }), "security").score).toBe(70);
  });

  it("applies fixed penalties to a missing test suite and README", () => {
    const r = score({
      findings: [
        { ...finding("TESTING", "HIGH", "testing/no-tests"), title: "No automated tests" },
        finding("DOCUMENTATION", "MEDIUM", "documentation/missing-readme"),
        finding("DOCUMENTATION", "LOW", "documentation/missing-license"),
      ],
    });
    expect(dim(r, "testing")).toMatchObject({ score: 20, factors: [{ label: "No automated tests", points: -80, detail: "Fixed penalty of 80 points (testing/no-tests)." }] });
    expect(dim(r, "documentation").score).toBe(58); // 100 − 40 − 2
  });

  it("deducts duplication above 5%, at most 15 points", () => {
    expect(dim(score({ duplicationPercent: 12.5 }), "codeQuality").factors).toEqual([
      { label: "12.5% duplicated code", points: -7.5, detail: "1 point per percent above 5%, at most 15." },
    ]);
    expect(dim(score({ duplicationPercent: 40 }), "codeQuality").score).toBe(85);
    expect(dim(score({ duplicationPercent: 4 }), "codeQuality").factors).toEqual([]);
  });

  it("leaves out dimensions without a subject and reweights the rest", () => {
    const r = score({ present: { code: true, dependencies: true, architecture: true, api: false, database: false }, findings: [finding("SECRET", "CRITICAL")] });
    expect(dim(r, "api")).toMatchObject({ applicable: false, score: null, effectiveWeight: 0, note: "No HTTP endpoints were detected." });
    expect(dim(r, "database").applicable).toBe(false);
    expect(dim(r, "security").effectiveWeight).toBeCloseTo(27.8, 1); // 25 ÷ 90
    // (25 × 70 + 65 × 100) ÷ 90 = 91.67
    expect(r.weightedScore).toBe(92);
  });

  it("scores a dimension that has findings even when its subject was not otherwise detected", () => {
    const r = score({ present: { ...ALL_PRESENT, database: false }, findings: [finding("DATABASE", "MEDIUM")] });
    expect(dim(r, "database")).toMatchObject({ applicable: true, score: 94 });
  });

  it("does not count findings triaged as Expected or Ignored, and says so", () => {
    const leaked = finding("SECRET", "CRITICAL");
    const r = score({ findings: [leaked, finding("SECRET", "LOW")], excludedFingerprints: new Set([leaked.fingerprint]) });
    expect(dim(r, "security")).toMatchObject({ score: 98, findings: 1, excluded: 1 });
    expect(r.excludedFindings).toBe(1);
    expect(r.caveats).toContain("1 finding triaged as Expected or Ignored was not counted.");
  });

  it("states when vulnerabilities or coverage were not measured", () => {
    const caveats = (vulnerabilityScan: ScoringInput["vulnerabilityScan"], coverageMeasured = true) => score({ vulnerabilityScan, coverageMeasured }).caveats;
    expect(caveats({ status: "disabled", notChecked: 0 })[0]).toContain("OSV_ENABLED=false");
    expect(caveats({ status: "failed", notChecked: 0 })[0]).toContain("lookup failed");
    expect(caveats({ status: "completed", notChecked: 3 })[0]).toContain("3 dependencies could not be checked");
    expect(caveats({ status: "completed", notChecked: 0 })).toEqual([]);
    expect(caveats(null, false)[0]).toContain("No coverage report was found");
  });

  it("never scores a dimension below 0", () => {
    const r = score({ findings: [finding("TESTING", "HIGH", "testing/no-tests"), ...Array.from({ length: 10 }, () => finding("TESTING", "HIGH"))] });
    expect(dim(r, "testing").score).toBe(0);
  });

  it("caps the score while high or critical security findings are open, unless they are triaged", () => {
    const high = finding("SECURITY", "HIGH");
    expect(score({ findings: [high] })).toMatchObject({ weightedScore: 96, score: 69, grade: "C", cap: { max: 69 } });
    expect(score({ findings: [high], excludedFingerprints: new Set([high.fingerprint]) })).toMatchObject({ score: 100, cap: null });
    // Dependency vulnerabilities count in their own dimension only.
    expect(score({ findings: [finding("DEPENDENCY", "CRITICAL")] })).toMatchObject({ cap: null, score: 96 });
    // A cap never raises a score.
    const many = Array.from({ length: 20 }, () => finding("CODE_QUALITY", "HIGH"));
    expect(score({ findings: [high, ...many], productionCodeLines: 1000 }).score).toBeLessThanOrEqual(69);
  });

  it("maps scores to grades", () => {
    expect([100, 90, 89, 75, 74, 60, 59, 40, 39, 0].map(gradeFor)).toEqual(["A", "A", "B", "B", "C", "C", "D", "D", "F", "F"]);
  });

  it("exposes the weights it used, summing to 100", () => {
    const w = scoringWeights();
    expect(Object.values(w.dimensions).reduce((n, d) => n + d.weight, 0)).toBe(100);
    expect(Object.keys(w.dimensions)).toEqual(SCORE_DIMENSIONS.map((d) => d.id));
    expect(w).toMatchObject({ version: "1.0", rulePenalty: { "testing/no-tests": 80 } });
  });
});
