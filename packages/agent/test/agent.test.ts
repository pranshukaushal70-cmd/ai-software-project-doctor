import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanRepository } from "@pd/analyzer";
import { buildRepositoryIndex, createSymbolCollector, RepositoryGraph } from "@pd/analyzer/intelligence";
import { analyzeCode } from "@pd/analyzer/metrics";
import {
  AnthropicProvider,
  BaselineProvider,
  buildPlanningContext,
  buildUserMessage,
  CONTEXT_LIMITS,
  createProvider,
  PLANNER_SYSTEM_PROMPT,
  ProviderError,
  runPlanner,
  ScriptedProvider,
  validatePlan,
  type AnthropicClientLike,
  type ContextSources,
  type PlanOutput,
  type PlanningContext,
  type RepositoryFacts,
} from "../src";

// ---------------------------------------------------------------- fixture: a real index of a small service

const REPO = {
  "package.json": JSON.stringify({ name: "shop-api", dependencies: { express: "4", jsonwebtoken: "9" }, devDependencies: { vitest: "1" } }),
  ".env": "JWT_SECRET=super-secret-value-123\n",
  "src/server.ts": 'import express from "express";\nimport { authRouter } from "./routes/auth";\nexport const app = express();\napp.use(authRouter);\n',
  "src/routes/auth.ts": `import { Router } from "express";
import { authenticateUser, issueSession } from "../auth/session";
export const authRouter = Router();
authRouter.post("/login", async (req, res) => {
  const user = await authenticateUser(req.body.email, req.body.password);
  res.json(issueSession(user));
});
`,
  "src/auth/session.ts": `import jwt from "jsonwebtoken";
export async function authenticateUser(email: string, password: string) {
  return { id: email };
}
export function issueSession(user: { id: string }) {
  return jwt.sign({ sub: user.id }, "k");
}
`,
  "src/products.ts": "export function listProducts() { return []; }\n",
  "tests/auth.test.ts": 'import { authenticateUser } from "../src/auth/session";\nit("logs in", () => authenticateUser("a", "b"));\n',
};

let root: string;
let sources: ContextSources;
let facts: RepositoryFacts;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "pd-agent-test-"));
  for (const [rel, text] of Object.entries(REPO)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  const scan = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
  const collector = createSymbolCollector();
  const code = await analyzeCode(scan.files, { onTree: collector.inspectTree });
  const index = await buildRepositoryIndex(scan, code, collector.files(), { name: "shop", moduleDepth: 2 });
  const graph = new RepositoryGraph({
    files: scan.files.map((f) => ({ id: f.path, path: f.path, kind: f.kind })),
    edges: index.dependencies.filter((d) => d.kind === "INTERNAL").map((d) => ({ from: d.from, to: d.to! })),
    symbols: index.symbols.map((s) => ({ id: s.key, fileId: s.path, name: s.name, kind: s.kind, parent: s.parent, exported: s.exported, line: s.line, endLine: s.endLine, signature: s.signature })),
    references: [],
    routes: [{ method: "POST", path: "/login", file: "src/routes/auth.ts", line: 4, framework: "Express" }],
    moduleDepth: 2,
  });
  sources = {
    graph,
    manifest: index.summary.manifest,
    repositoryName: "shop",
    routes: [{ method: "POST", path: "/login", file: "src/routes/auth.ts", line: 4, framework: "Express" }],
    findings: [
      { ruleId: "api/auth-without-rate-limit", title: "Login endpoint without rate limiting", severity: "LOW", path: "src/routes/auth.ts", line: 4 },
      { ruleId: "complexity/high-cyclomatic", title: "Function has high cyclomatic complexity", severity: "MEDIUM", path: "src/products.ts", line: 1 },
    ],
    externalImports: index.dependencies.filter((d) => d.kind === "EXTERNAL").map((d) => ({ path: d.from, packageName: d.packageName! })),
  };
  const kinds = new Map(scan.files.map((f) => [f.path, f.kind] as const));
  facts = { files: kinds, hasSymbol: (name, p) => graph.findSymbols(name, p).length > 0 };
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const TASK = { request: "Add rate limiting to the login endpoint" };
const contextFor = (task = TASK) => buildPlanningContext(task, sources);
const idOf = (ctx: PlanningContext, pred: (e: PlanningContext["evidence"][number]) => boolean) => ctx.evidence.find(pred)!.id;

/** A well-grounded plan for the task, citing real evidence. */
function goodPlan(ctx: PlanningContext): PlanOutput {
  const route = idOf(ctx, (e) => e.kind === "ROUTE");
  const finding = idOf(ctx, (e) => e.kind === "FINDING");
  const test = idOf(ctx, (e) => e.kind === "TEST");
  return {
    taskSummary: "Limit login attempts on POST /login.",
    interpretation: "Throttle failed and repeated login attempts per account and IP.",
    assumptions: [{ statement: "There is no rate limiting today.", certainty: "VERIFIED", evidence: [finding] }],
    affectedFiles: [
      { path: "src/routes/auth.ts", change: "modify", reason: "Declares POST /login.", certainty: "VERIFIED", evidence: [route] },
      { path: "src/middleware/rate-limit.ts", change: "create", reason: "New limiter middleware.", certainty: "INFERRED", evidence: [] },
    ],
    affectedSymbols: [{ name: "authenticateUser", path: "src/auth/session.ts", change: "review", reason: "Called by the login route.", certainty: "INFERRED", evidence: [route] }],
    architectureImpact: { statement: "Adds a middleware in front of the login route.", certainty: "INFERRED", evidence: [route] },
    implementationSteps: [{ title: "Add a limiter", description: "Create the middleware and apply it to the login route.", files: ["src/middleware/rate-limit.ts", "src/routes/auth.ts"], evidence: [route] }],
    testPlan: [
      { description: "Existing login test still passes.", path: "tests/auth.test.ts", kind: "existing", evidence: [test] },
      { description: "Rejects the 11th attempt within the window.", path: "tests/rate-limit.test.ts", kind: "new", evidence: [] },
    ],
    configurationChanges: [],
    dependencyChanges: [{ package: "express-rate-limit", change: "add", reason: "Standard limiter for Express.", certainty: "INFERRED", evidence: [] }],
    securityConsiderations: [{ statement: "Limit by account and by IP to slow credential stuffing.", certainty: "INFERRED", evidence: [finding] }],
    performanceConsiderations: [],
    risks: [{ description: "Shared IPs may be throttled.", severity: "MEDIUM", mitigation: "Key on account and IP.", evidence: [] }],
    validationPlan: ["Run the API test suite and confirm the login tests pass."],
    unknowns: ["Whether the service runs behind a proxy that hides client IPs."],
    confidence: 0.8,
  };
}

describe("context retrieval", () => {
  it("collects the login route, its file, symbols, tests, configuration, packages and the existing finding", () => {
    const ctx = contextFor();
    const kinds = (k: string) => ctx.evidence.filter((e) => e.kind === k);
    expect(kinds("ROUTE").map((e) => e.symbol)).toEqual(["POST /login"]);
    expect(kinds("FILE").map((e) => e.path)).toContain("src/routes/auth.ts");
    expect(kinds("TEST").map((e) => e.path)).toContain("tests/auth.test.ts");
    expect(kinds("CONFIG").map((e) => e.path)).toContain("package.json");
    expect(kinds("PACKAGE").map((e) => e.symbol)).toContain("express");
    expect(kinds("FINDING").map((e) => e.symbol)).toEqual(["api/auth-without-rate-limit"]);
    expect(kinds("MANIFEST")).toHaveLength(2);
    expect(ctx.evidence.map((e) => e.id)).toEqual(ctx.evidence.map((_, i) => `E${i + 1}`));
    expect(ctx.repository).toMatchObject({ name: "shop", primaryLanguage: "typescript", frameworks: expect.arrayContaining(["Express"]), testFrameworks: ["Vitest"] });
  });

  it("is deterministic and bounded", () => {
    expect(contextFor()).toEqual(contextFor());
    expect(contextFor().evidence.length).toBeLessThanOrEqual(CONTEXT_LIMITS.evidence);
  });

  it("never carries file contents or secret values", () => {
    const text = JSON.stringify(contextFor()) + buildUserMessage(contextFor());
    expect(text).not.toContain("super-secret-value-123");
    expect(text).not.toContain("jwt.sign");
  });

  it("restricts evidence to the scope", () => {
    const ctx = contextFor({ request: "Add rate limiting to the login endpoint", scope: "src/auth" } as typeof TASK);
    expect(ctx.evidence.filter((e) => e.kind === "FILE" || e.kind === "SYMBOL").every((e) => e.path!.startsWith("src/auth/"))).toBe(true);
    expect(ctx.task.scope).toBe("src/auth");
  });

  it("puts only the task and numbered evidence in the prompt; the system prompt is stable", () => {
    const msg = buildUserMessage(contextFor());
    expect(msg).toContain("Developer task: Add rate limiting to the login endpoint");
    expect(msg).toMatch(/E\d+ \[ROUTE\] Express route POST \/login is declared in src\/routes\/auth.ts:4\./);
    expect(PLANNER_SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe("plan validation", () => {
  it("passes a grounded plan unchanged", () => {
    const ctx = contextFor();
    const { plan, report } = validatePlan(goodPlan(ctx), ctx, facts);
    expect(report).toEqual({ status: "PASSED", issues: [], modelConfidence: 0.8, confidence: 0.8 });
    expect(plan!.affectedFiles.every((f) => f.flags.length === 0)).toBe(true);
  });

  it("flags nonexistent files and hallucinated symbols, and lowers confidence", () => {
    const ctx = contextFor();
    const p = goodPlan(ctx);
    p.affectedFiles.push({ path: "src/auth/login-controller.ts", change: "modify", reason: "Handles login.", certainty: "VERIFIED", evidence: [ctx.evidence[0]!.id] });
    p.affectedSymbols.push({ name: "loginHandler", path: "src/routes/auth.ts", change: "modify", reason: "Login handler.", certainty: "VERIFIED", evidence: [ctx.evidence[0]!.id] });
    const { plan, report } = validatePlan(p, ctx, facts);
    expect(report.status).toBe("ERRORS");
    expect(report.issues.map((i) => i.code)).toEqual(["nonexistent-file", "nonexistent-symbol"]);
    expect(plan!.affectedFiles.at(-1)).toMatchObject({ flags: ["nonexistent-file"], certainty: "UNKNOWN" });
    expect(plan!.affectedSymbols.at(-1)).toMatchObject({ flags: ["nonexistent-symbol"], certainty: "UNKNOWN" });
    expect(report.confidence).toBe(0.6);
  });

  it("removes evidence ids that are not in the context and downgrades unsupported VERIFIED claims", () => {
    const ctx = contextFor();
    const p = goodPlan(ctx);
    p.assumptions = [{ statement: "Sessions are stored in Redis.", certainty: "VERIFIED", evidence: ["E999", "made-up"] }];
    const { plan, report } = validatePlan(p, ctx, facts);
    expect(plan!.assumptions[0]).toEqual({ statement: "Sessions are stored in Redis.", certainty: "INFERRED", evidence: [] });
    expect(report.issues.map((i) => i.code)).toEqual(["unknown-evidence", "unknown-evidence", "unsupported-verified"]);
    expect(report.status).toBe("WARNINGS");
  });

  it("removes shell commands and redacts secrets anywhere in the plan", () => {
    const ctx = contextFor();
    const p = goodPlan(ctx);
    p.validationPlan = ["Run `npm install express-rate-limit && npm test`.", "Confirm 429 responses after ten attempts."];
    p.implementationSteps[0]!.description = 'Set JWT_SECRET = "s3cr3t-v4lue-0987654321abcdef" in the config.';
    p.risks[0]!.mitigation = "curl http://localhost:3000/login in a loop";
    const { plan, report } = validatePlan(p, ctx, facts);
    expect(plan!.validationPlan).toEqual(["[shell command removed by validation]", "Confirm 429 responses after ten attempts."]);
    expect(plan!.implementationSteps[0]!.description).not.toContain("s3cr3t-v4lue");
    expect(plan!.risks[0]!.mitigation).toBe("[shell command removed by validation]");
    expect(report.issues.map((i) => i.code).sort()).toEqual(["command", "command", "secret"]);
  });

  it("rejects paths outside the repository and flags secret files", () => {
    const ctx = contextFor();
    const p = goodPlan(ctx);
    p.affectedFiles = [
      { path: "/etc/passwd", change: "modify", reason: "x", certainty: "INFERRED", evidence: [] },
      { path: "../outside.ts", change: "create", reason: "x", certainty: "INFERRED", evidence: [] },
      { path: "C:/Windows/system.ini", change: "review", reason: "x", certainty: "INFERRED", evidence: [] },
      { path: ".env", change: "modify", reason: "Add the limit.", certainty: "INFERRED", evidence: [] },
    ];
    const { plan, report } = validatePlan(p, ctx, facts);
    expect(plan!.affectedFiles.map((f) => f.path)).toEqual(["[invalid path removed]", "[invalid path removed]", "[invalid path removed]", ".env"]);
    // The step still names the new middleware, which is no longer listed in affectedFiles.
    expect(report.issues.map((i) => i.code)).toEqual(["invalid-path", "invalid-path", "invalid-path", "secret-file", "unlisted-step-file"]);
  });

  it("checks test references and new-file proposals", () => {
    const ctx = contextFor();
    const p = goodPlan(ctx);
    p.testPlan = [
      { description: "x", path: "src/routes/auth.ts", kind: "existing", evidence: [] },
      { description: "x", path: "src/limits.ts", kind: "new", evidence: [] },
    ];
    p.affectedFiles.push({ path: "src/server.ts", change: "create", reason: "x", certainty: "INFERRED", evidence: [] });
    p.implementationSteps.push({ title: "x", description: "x", files: ["src/somewhere/else.ts"], evidence: [] });
    const codes = validatePlan(p, ctx, facts).report.issues.map((i) => i.code);
    expect(codes).toEqual(["file-exists", "unlisted-step-file", "test-not-found", "implausible-test-path"]);
  });

  it("rejects output that does not match the schema, and clamps confidence", () => {
    const ctx = contextFor();
    expect(validatePlan({ taskSummary: "x" }, ctx, facts).report).toMatchObject({ status: "REJECTED", confidence: 0 });
    expect(validatePlan("not an object", ctx, facts).plan).toBeNull();
    expect(validatePlan({ ...goodPlan(ctx), confidence: 7 }, ctx, facts).report.modelConfidence).toBe(1);
    expect(validatePlan({ ...goodPlan(ctx), affectedFiles: [{ path: "a.ts", change: "rewrite" }] }, ctx, facts).report.status).toBe("REJECTED");
  });
});

describe("providers", () => {
  const fakeClient = (respond: (params: Record<string, unknown>) => unknown) => {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      beta: {
        messages: {
          create: (async (params: Record<string, unknown>) => {
            calls.push(params);
            const r = respond(params);
            if (r instanceof Error) throw r;
            return r;
          }) as unknown as AnthropicClientLike["beta"]["messages"]["create"],
        },
      },
    };
    return { client, calls };
  };
  const message = (text: string, stop_reason = "end_turn") => ({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason,
    usage: { input_tokens: 1200, output_tokens: 800 },
  });

  it("calls Claude with structured output, refusal fallbacks and a cacheable system prompt", async () => {
    const ctx = contextFor();
    const { client, calls } = fakeClient(() => message(JSON.stringify(goodPlan(ctx))));
    const result = await new AnthropicProvider({ client }).generatePlan(ctx);
    expect(result).toMatchObject({ model: "claude-opus-5-5", inputTokens: 1200, outputTokens: 800, stopReason: "end_turn" });
    expect(result.output).toEqual(goodPlan(ctx));
    const req = calls[0]!;
    expect(req).toMatchObject({ model: "claude-opus-5-5", max_tokens: 16000, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    expect(req.output_config).toMatchObject({ effort: "high", format: { type: "json_schema", schema: expect.objectContaining({ type: "object" }) } });
    expect(req.system).toEqual([{ type: "text", text: PLANNER_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(JSON.stringify(req.messages)).not.toContain("super-secret-value-123");
  });

  it("turns refusals, truncation, invalid JSON and API errors into safe provider errors", async () => {
    const ctx = contextFor();
    const reason = async (respond: () => unknown) => {
      try {
        await new AnthropicProvider({ client: fakeClient(respond).client }).generatePlan(ctx);
        return "no error";
      } catch (err) {
        return err instanceof ProviderError ? err.reason : "other";
      }
    };
    expect(await reason(() => message("", "refusal"))).toBe("refused");
    expect(await reason(() => message('{"taskSummary":', "max_tokens"))).toBe("truncated");
    expect(await reason(() => message("Sure! Here is your plan."))).toBe("invalid-json");
    expect(await reason(() => new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers()))).toBe("rate-limited");
    expect(await reason(() => new Anthropic.AuthenticationError(401, undefined, "bad key", new Headers()))).toBe("not-configured");
    expect(await reason(() => new TypeError("fetch failed"))).toBe("api-error");
  });

  it("is chosen from the environment; the API key is required for Anthropic and never exposed", () => {
    expect(() => createProvider({})).toThrow(ProviderError);
    expect(createProvider({ AI_PROVIDER: "baseline" }).name).toBe("baseline");
    const p = createProvider({ ANTHROPIC_API_KEY: "sk-ant-test-key", ANTHROPIC_MODEL: "claude-sonnet-5-5" });
    expect({ name: p.name, model: p.model }).toEqual({ name: "anthropic", model: "claude-sonnet-5-5" });
    expect(Object.entries(p).filter(([, v]) => typeof v === "string").map(([, v]) => v)).not.toContain("sk-ant-test-key");
    expect(createProvider({ ANTHROPIC_API_KEY: "k" }).model).toBe("claude-opus-5-5");
    expect(() => createProvider({ AI_PROVIDER: "gpt" })).toThrow(/Unsupported AI_PROVIDER/);
  });
});

describe("runPlanner", () => {
  it("validates a provider plan and records metadata", async () => {
    const ctx = contextFor();
    const result = await runPlanner(ctx, new ScriptedProvider([goodPlan(ctx)]), facts);
    expect(result).toMatchObject({ ok: true, report: { status: "PASSED" }, meta: { provider: "scripted", model: "scripted", inputTokens: 100, outputTokens: 50 } });
  });

  it("reports invalid output and provider failures without a plan", async () => {
    const ctx = contextFor();
    expect(await runPlanner(ctx, new ScriptedProvider([{ nope: true }]), facts)).toMatchObject({ ok: false, reason: "invalid-output", report: { status: "REJECTED" } });
    expect(await runPlanner(ctx, new ScriptedProvider([new ProviderError("refused", "declined")]), facts)).toMatchObject({ ok: false, reason: "refused", message: "declined", report: null });
    expect(await runPlanner(ctx, new ScriptedProvider([new Error("boom /home/secret")]), facts)).toMatchObject({ ok: false, reason: "api-error", message: "The AI provider failed unexpectedly." });
  });

  it("the baseline planner's evidence-only plan validates with no errors", async () => {
    const ctx = contextFor();
    const result = await runPlanner(ctx, new BaselineProvider(), facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.plan.affectedFiles.map((f) => f.path)).toContain("src/routes/auth.ts");
    expect(result.plan.testPlan.map((t) => t.path)).toContain("tests/auth.test.ts");
    expect(result.meta).toMatchObject({ provider: "baseline", model: "deterministic" });
  });
});
