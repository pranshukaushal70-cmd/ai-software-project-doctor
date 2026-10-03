import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { validatePlan, type PlanOutput, type PlanningContext } from "@pd/agent";
import { certaintyCounts, PlanView, type PlanDto } from "@/components/planner/plan-view";
import { PlannerView } from "@/components/planner/planner-view";

const CONTEXT: PlanningContext = {
  task: { request: "Add rate limiting to the login endpoint", scope: null, constraints: [] },
  repository: { name: "shop", primaryLanguage: "typescript", languages: ["typescript"], frameworks: ["Express"], testFrameworks: ["Vitest"], packageManagers: ["npm"], runtimes: [] },
  evidence: [
    { id: "E1", kind: "ROUTE", path: "src/routes/auth.ts", symbol: "POST /login", line: 4, summary: "Express route POST /login is declared in src/routes/auth.ts:4.", source: "routes" },
    { id: "E2", kind: "TEST", path: "tests/auth.test.ts", symbol: null, line: null, summary: "Test tests/auth.test.ts reaches src/routes/auth.ts through imports (distance 1).", source: "related-tests" },
  ],
  stats: { searchHits: 5, candidateFiles: 2, evidence: 2, truncated: false },
};
const FACTS = {
  files: new Map([
    ["src/routes/auth.ts", "SOURCE"],
    ["tests/auth.test.ts", "TEST"],
  ] as const),
  hasSymbol: (name: string) => name === "authRouter",
};

const OUTPUT: PlanOutput = {
  taskSummary: "Limit login attempts on POST /login.",
  interpretation: "Throttle repeated login attempts.",
  assumptions: [{ statement: "No limiter exists today.", certainty: "INFERRED", evidence: ["E1"] }],
  affectedFiles: [
    { path: "src/routes/auth.ts", change: "modify", reason: "Declares POST /login.", certainty: "VERIFIED", evidence: ["E1"] },
    { path: "src/auth/login-controller.ts", change: "modify", reason: "Invented file.", certainty: "VERIFIED", evidence: ["E1"] },
  ],
  affectedSymbols: [{ name: "authRouter", path: "src/routes/auth.ts", change: "modify", reason: "Router of the login route.", certainty: "VERIFIED", evidence: ["E1"] }],
  architectureImpact: { statement: "Adds a middleware in front of the login route.", certainty: "INFERRED", evidence: ["E1"] },
  implementationSteps: [{ title: "Add a limiter middleware", description: "Apply it to POST /login.", files: ["src/routes/auth.ts"], evidence: ["E1"] }],
  testPlan: [
    { description: "Existing login test passes.", path: "tests/auth.test.ts", kind: "existing", evidence: ["E2"] },
    { description: "Eleventh attempt is rejected.", path: "tests/rate-limit.test.ts", kind: "new", evidence: [] },
  ],
  configurationChanges: [],
  dependencyChanges: [{ package: "express-rate-limit", change: "add", reason: "Limiter for Express.", certainty: "INFERRED", evidence: [] }],
  securityConsiderations: [{ statement: "Key by account and IP.", certainty: "INFERRED", evidence: [] }],
  performanceConsiderations: [],
  risks: [{ description: "Shared IPs may be throttled.", severity: "MEDIUM", mitigation: "Key on account and IP.", evidence: [] }],
  validationPlan: ["Run the API tests and confirm the login tests pass."],
  unknowns: ["Whether a proxy hides client IPs."],
  confidence: 0.8,
};

function dto(extra: Partial<PlanDto> = {}): PlanDto {
  const { plan, report } = validatePlan(OUTPUT, CONTEXT, FACTS);
  return {
    id: "p1",
    status: "COMPLETED",
    inProgress: false,
    provider: "anthropic",
    model: "claude-opus-5-5",
    validationStatus: report.status,
    confidence: report.confidence,
    failureReason: null,
    error: null,
    plan,
    validation: report,
    contextStats: CONTEXT.stats,
    inputTokens: 1500,
    outputTokens: 900,
    durationMs: 12300,
    evidence: CONTEXT.evidence.map(({ id, ...e }) => ({ ref: id, ...e })),
    ...extra,
  };
}

const render = (plan: PlanDto) => renderToStaticMarkup(createElement(PlanView, { plan }));

describe("PlanView", () => {
  it("shows certainty, evidence links, validation flags, confidence and provider metadata", () => {
    const d = dto();
    const html = render(d);
    expect(html).toContain("Validation: ERRORS");
    expect(html).toContain("Confidence 70%");
    expect(html).toContain("model said 80%; lowered for validation issues");
    expect(html).toContain("anthropic · claude-opus-5-5");
    expect(html).toContain("1500 in / 900 out tokens");
    expect(html).toContain("src/auth/login-controller.ts");
    expect(html).toContain("file not found");
    expect(html).toContain("does not exist in the repository index");
    expect(html).toContain('href="#evidence-E1"');
    expect(html).toContain('id="evidence-E1"');
    expect(html).toContain("existing test");
    expect(html).toContain("new test");
    expect(html).toContain("Whether a proxy hides client IPs.");
    for (const c of ["VERIFIED", "INFERRED", "UNKNOWN"]) expect(html).toContain(`>${c}<`);
    // The hallucinated file is downgraded to UNKNOWN by validation.
    expect(certaintyCounts(d.plan!)).toEqual({ VERIFIED: 2, INFERRED: 4, UNKNOWN: 1 });
    expect(html).toMatch(/<strong[^>]*>2<\/strong> verified · <strong[^>]*>4<\/strong> inferred · <strong>1<\/strong> unknown/);
  });

  it("shows progress while the plan is generated", () => {
    const html = render(dto({ status: "RUNNING", inProgress: true, plan: null, validation: null }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Generating the plan with anthropic (claude-opus-5-5)");
  });

  it("explains failures, including why output was rejected", () => {
    const rejected = validatePlan({ taskSummary: 1 }, CONTEXT, FACTS).report;
    const html = render(dto({ status: "FAILED", plan: null, validation: rejected, error: "The model's output did not match the plan schema and was rejected." }));
    expect(html).toContain("Planning failed");
    expect(html).toContain("did not match the plan schema");
    expect(html).toContain("Why the output was rejected");
  });
});

describe("PlannerView", () => {
  it("offers the analysed repositories and a task form", () => {
    const html = renderToStaticMarkup(
      createElement(PlannerView, {
        analyses: [
          { id: "an1", repository: "acme/shop", createdAt: "2026-10-01T10:00:00.000Z" },
          { id: "an2", repository: "acme/api", createdAt: "2026-09-30T10:00:00.000Z" },
        ],
        initialAnalysisId: "an2",
      }),
    );
    expect(html).toContain("acme/shop");
    expect(html).toMatch(/<option value="an2" selected="">acme\/api/);
    expect(html).toContain('name="task"');
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain("Plan this task");
    expect(html).toContain("Planning only: nothing is changed, run or committed.");
  });

  it("explains what to do when nothing has been analysed", () => {
    const html = renderToStaticMarkup(createElement(PlannerView, { analyses: [], initialAnalysisId: null }));
    expect(html).toContain("Run an analysis first");
  });
});
