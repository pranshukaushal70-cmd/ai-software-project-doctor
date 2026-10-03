import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { FileKind } from "@pd/analyzer";
import { checkChanges } from "../src/edit-checks";
import {
  AnthropicProvider,
  buildEditContext,
  buildEditUserMessage,
  createEditProvider,
  deriveEditScope,
  EDIT_LIMITS,
  EDITOR_SYSTEM_PROMPT,
  forbiddenReason,
  ProviderError,
  runEditor,
  ScriptedProvider,
  validateEdits,
  type AnthropicClientLike,
  type EditContext,
  type EditOutput,
  type RepositoryFacts,
  type ValidatedPlan,
} from "../src";

// ---------------------------------------------------------------- fixtures

const BOM = String.fromCharCode(0xfeff);
// A fake key in Stripe's live-key format, assembled at runtime so secret scanners do not flag this source.
const FAKE_KEY = ["sk", "live", "51HaBcDeFgHiJkLmNoPqRsTuV"].join("_");

const FILES: Record<string, { kind: FileKind; text: string }> = {
  "package.json": { kind: "CONFIG", text: '{ "name": "shop", "dependencies": { "express": "4" } }\n' },
  "package-lock.json": { kind: "GENERATED", text: "{}\n" },
  ".env": { kind: "CONFIG", text: "JWT_SECRET=super-secret-value-123\n" },
  "Dockerfile": { kind: "CONFIG", text: "FROM node:24\n" },
  ".github/workflows/ci.yml": { kind: "CONFIG", text: "on: push\n" },
  "src/routes/auth.ts": {
    kind: "SOURCE",
    text: 'import { Router } from "express";\r\nexport const authRouter = Router();\r\nauthRouter.post("/login", login);\r\n',
  },
  "src/auth/session.ts": { kind: "SOURCE", text: `export const signingKey = "${FAKE_KEY}";\nexport function login() {\n  return true;\n}\n` },
  "src/legacy.ts": { kind: "SOURCE", text: "export const old = 1;\n" },
  "src/big.ts": { kind: "SOURCE", text: `export const big = "${"x".repeat(EDIT_LIMITS.contextFileBytes)}";\n` },
  "tests/auth.test.ts": { kind: "TEST", text: 'import { login } from "../src/auth/session";\nit("logs in", () => login());\n' },
};

const facts: RepositoryFacts = {
  files: new Map(Object.entries(FILES).map(([p, f]) => [p, f.kind])),
  hasSymbol: () => true,
};
const readFile = async (p: string) => FILES[p]?.text ?? null;

const file = (path: string, change: "modify" | "create" | "delete" | "review", flags: string[] = []) => ({ path, change, reason: "r", certainty: "VERIFIED" as const, evidence: [], flags });

function plan(over: Partial<ValidatedPlan> = {}): ValidatedPlan {
  return {
    taskSummary: "Add rate limiting to login.",
    interpretation: "Throttle POST /login.",
    assumptions: [],
    affectedFiles: [
      file("src/routes/auth.ts", "modify"),
      file("src/auth/session.ts", "review"),
      file("src/legacy.ts", "delete"),
      file("src/middleware/rate-limit.ts", "create"),
      file("src/ghost.ts", "modify", ["nonexistent-file"]),
      file("package-lock.json", "modify"),
      file(".env", "review"),
      file("Dockerfile", "modify"),
      file("src/big.ts", "modify"),
    ],
    affectedSymbols: [],
    architectureImpact: { statement: "s", certainty: "INFERRED", evidence: [] },
    implementationSteps: [{ title: "Add limiter", description: "Wrap the login route.", files: ["src/routes/auth.ts"], evidence: [], flags: [] }],
    testPlan: [
      { description: "Login still works.", path: "tests/auth.test.ts", kind: "existing", evidence: [], flags: [] },
      { description: "Limiter blocks bursts.", path: "tests/rate-limit.test.ts", kind: "new", evidence: [], flags: [] },
    ],
    configurationChanges: [],
    dependencyChanges: [],
    securityConsiderations: [],
    performanceConsiderations: [],
    risks: [],
    validationPlan: [],
    unknowns: [],
    confidence: 0.8,
    ...over,
  };
}

async function setup(p = plan()) {
  const scope = deriveEditScope(p, facts);
  const built = await buildEditContext({ task: { request: "Add rate limiting to the login endpoint", constraints: [] }, plan: p, scope, facts, readFile });
  return { scope, ...built };
}

const output = (changes: EditOutput["changes"], over: Partial<EditOutput> = {}): EditOutput => ({ summary: "Adds a limiter.", changes, notes: [], confidence: 0.9, ...over });
const modify = (path: string, edits: Array<{ find: string; replace: string }>) => ({ path, operation: "modify" as const, reason: "r", edits, content: null });
const create = (path: string, content: string) => ({ path, operation: "create" as const, reason: "r", edits: [], content });

// ---------------------------------------------------------------- scope and policy

describe("edit scope", () => {
  it("is derived from the approved plan, without flagged or forbidden files", async () => {
    const { scope } = await setup();
    expect(scope).toEqual({
      modify: ["src/big.ts", "src/routes/auth.ts", "tests/auth.test.ts"],
      create: ["src/middleware/rate-limit.ts", "tests/rate-limit.test.ts"],
      delete: ["src/legacy.ts"],
      newTests: true,
      dependencyChanges: false,
    });
  });

  it.each([
    [".env", "a file that holds secrets"],
    ["config/.env.production", "a file that holds secrets"],
    ["certs/server.key", "a file that holds secrets"],
    ["package-lock.json", "a lockfile (regenerated by the package manager, never edited)"],
    ["Dockerfile", "CI, container or deployment configuration"],
    [".github/workflows/ci.yml", "CI configuration"],
    [".github/CODEOWNERS", "CI configuration"],
    [".gitattributes", "Git configuration (attributes and submodules can run filters or fetch code)"],
    [".husky/pre-commit", "Git hook configuration"],
    [".git/config", "Git metadata"],
    [".pnpmfile.cjs", "package-manager configuration"],
  ])("never lets the engine change %s", (p, reason) => {
    expect(forbiddenReason(p)).toBe(reason);
  });

  it.each(["src/app.ts", "tests/app.test.ts", "README.md", ".env.example", "tsconfig.json", ".gitignore"])("allows %s within scope", (p) => {
    expect(forbiddenReason(p)).toBeNull();
  });
});

// ---------------------------------------------------------------- context

describe("edit context", () => {
  it("shows in-scope files redacted and normalised, keeps originals local, and never shows secret files", async () => {
    const { context, originals } = await setup();
    const shown = Object.fromEntries(context.files.map((f) => [f.path, f]));
    expect(Object.keys(shown).sort()).toEqual(["src/auth/session.ts", "src/legacy.ts", "src/routes/auth.ts", "tests/auth.test.ts"]);
    expect(shown["src/routes/auth.ts"]).toMatchObject({ purpose: "modify", redacted: false });
    expect(shown["src/routes/auth.ts"]!.content).not.toContain("\r");
    expect(shown["src/auth/session.ts"]).toMatchObject({ purpose: "reference", redacted: true });
    expect(shown["tests/auth.test.ts"]!.purpose).toBe("test");
    expect(shown["src/legacy.ts"]!.purpose).toBe("delete");
    // The originals are untouched (CRLF, the key) but never part of the context.
    expect(originals.get("src/routes/auth.ts")).toBe(FILES["src/routes/auth.ts"]!.text);
    expect(originals.get("src/auth/session.ts")).toContain(FAKE_KEY);
    const message = buildEditUserMessage(context);
    expect(JSON.stringify(context)).not.toContain(FAKE_KEY);
    expect(message).not.toContain(FAKE_KEY);
    expect(message).not.toContain("super-secret-value-123");
    expect(context.omitted).toEqual(expect.arrayContaining([{ path: ".env", reason: "holds secrets; never shown" }, { path: "src/big.ts", reason: "larger than 64 KB" }]));
  });

  it("omits binary and unreadable files", async () => {
    const p = plan({ affectedFiles: [file("src/routes/auth.ts", "modify"), file("src/legacy.ts", "modify")] });
    const scope = deriveEditScope(p, facts);
    const { context } = await buildEditContext({
      task: { request: "t", constraints: [] },
      plan: p,
      scope,
      facts,
      readFile: async (path) => (path === "src/legacy.ts" ? "bin\u0000ary" : null),
    });
    expect(context.files).toEqual([]);
    expect(context.omitted).toEqual([
      { path: "src/legacy.ts", reason: "binary content" },
      { path: "src/routes/auth.ts", reason: "could not be read" },
      // The plan's existing test is in scope too.
      { path: "tests/auth.test.ts", reason: "could not be read" },
    ]);
  });
});

// ---------------------------------------------------------------- validation

describe("validateEdits", () => {
  it("applies exact edits to the originals, keeping CRLF, and produces a diff", async () => {
    const { context, originals } = await setup();
    const v = validateEdits(
      output([
        modify("src/routes/auth.ts", [{ find: 'authRouter.post("/login", login);', replace: 'authRouter.post("/login", rateLimit, login);' }]),
        create("src/middleware/rate-limit.ts", "export function rateLimit() {}\n"),
        create("tests/rate-limit.test.ts", 'it("limits", () => {});\n'),
        { path: "src/legacy.ts", operation: "delete", reason: "unused", edits: [], content: null },
      ]),
      context,
      originals,
      facts,
    );
    expect(v.report).toMatchObject({ status: "PASSED", accepted: 4, rejected: 0, confidence: 0.9 });
    const auth = v.changes[0]!;
    expect(auth.after).toBe('import { Router } from "express";\r\nexport const authRouter = Router();\r\nauthRouter.post("/login", rateLimit, login);\r\n');
    expect(auth.diff).toContain('-authRouter.post("/login", login);\r\n+authRouter.post("/login", rateLimit, login);\r\n');
    expect({ additions: auth.additions, deletions: auth.deletions }).toEqual({ additions: 1, deletions: 1 });
    expect(v.changes[3]).toMatchObject({ status: "accepted", before: "export const old = 1;\n", after: null });
  });

  it("keeps a byte-order mark", async () => {
    const withBom = { ...FILES, "src/legacy.ts": { kind: "SOURCE" as const, text: `${BOM}export const old = 1;\n` } };
    const p = plan({ affectedFiles: [file("src/legacy.ts", "modify")] });
    const { context, originals } = await buildEditContext({ task: { request: "t", constraints: [] }, plan: p, scope: deriveEditScope(p, facts), facts, readFile: async (x) => withBom[x as keyof typeof withBom]?.text ?? null });
    const v = validateEdits(output([modify("src/legacy.ts", [{ find: "old = 1", replace: "old = 2" }])]), context, originals, facts);
    expect(v.changes[0]!.after).toBe(`${BOM}export const old = 2;\n`);
  });

  it("rejects changes outside the approved scope and to forbidden files", async () => {
    const { context, originals } = await setup();
    const v = validateEdits(
      output([
        modify("src/auth/session.ts", [{ find: "return true;", replace: "return false;" }]), // review only
        create("src/extra.ts", "export {};\n"), // not planned
        modify(".env", [{ find: "JWT", replace: "X" }]),
        modify("package-lock.json", [{ find: "{}", replace: "{ }" }]),
        modify(".github/workflows/ci.yml", [{ find: "push", replace: "pull_request" }]),
        create("../outside.ts", "x"),
        { path: "src/routes/auth.ts", operation: "delete", reason: "r", edits: [], content: null },
      ]),
      context,
      originals,
      facts,
    );
    expect(v.changes.map((c) => [c.status, c.flags])).toEqual([
      ["rejected", ["out-of-scope"]],
      ["rejected", ["out-of-scope"]],
      ["rejected", ["forbidden-path"]],
      ["rejected", ["forbidden-path"]],
      ["rejected", ["forbidden-path"]],
      ["rejected", ["invalid-path"]],
      ["rejected", ["out-of-scope"]],
    ]);
    expect(v.changes[5]!.path).toBe("[invalid path removed]");
    expect(v.report).toMatchObject({ status: "ERRORS", accepted: 0, rejected: 7 });
  });

  it("accepts new tests the plan did not name, with a warning, but not other new files", async () => {
    const { context, originals } = await setup();
    const v = validateEdits(output([create("tests/login-burst.test.ts", 'it("x", () => {});\n'), create("src/helpers.ts", "export {};\n")]), context, originals, facts);
    expect(v.changes.map((c) => [c.status, c.flags])).toEqual([
      ["accepted", ["unlisted-test"]],
      ["rejected", ["out-of-scope"]],
    ]);
  });

  it("only lets package manifests change when the plan approves a dependency change", async () => {
    const withManifest = plan({ affectedFiles: [file("package.json", "modify")] });
    const edit = output([modify("package.json", [{ find: '"express": "4"', replace: '"express": "4", "express-rate-limit": "7"' }])]);
    let s = await setup(withManifest);
    expect(validateEdits(edit, s.context, s.originals, facts).changes[0]!.flags).toEqual(["dependency-change-not-approved"]);
    s = await setup({ ...withManifest, dependencyChanges: [{ package: "express-rate-limit", change: "add", reason: "r", certainty: "INFERRED", evidence: [] }] });
    expect(validateEdits(edit, s.context, s.originals, facts).changes[0]!.status).toBe("accepted");
  });

  it("requires every find to match the original exactly once", async () => {
    const { context, originals } = await setup();
    const one = (find: string) => validateEdits(output([modify("tests/auth.test.ts", [{ find, replace: "x" }])]), context, originals, facts).changes[0]!.flags;
    expect(one("not in the file")).toEqual(["anchor-not-found"]);
    expect(one('"')).toEqual(["anchor-ambiguous"]);
    expect(one("")).toEqual(["anchor-empty"]);
    // Edits apply in order: the second sees the first's result.
    const v = validateEdits(output([modify("tests/auth.test.ts", [{ find: "logs in", replace: "signs in" }, { find: "signs in", replace: "logs in ok" }])]), context, originals, facts);
    expect(v.changes[0]!.after).toContain('it("logs in ok"');
  });

  it("refuses edits that touch redacted values, add credentials or binary content", async () => {
    const p = plan({ affectedFiles: [file("src/auth/session.ts", "modify")] });
    const { context, originals } = await setup(p);
    const flags = (edits: Array<{ find: string; replace: string }>) => validateEdits(output([modify("src/auth/session.ts", edits)]), context, originals, facts).changes[0]!.flags;
    expect(flags([{ find: 'signingKey = "<redacted>"', replace: "signingKey = process.env.SIGNING_KEY" }])).toEqual(["touches-redacted"]);
    expect(flags([{ find: "return true;", replace: 'return "<redacted>";' }])).toEqual(["touches-redacted"]);
    expect(flags([{ find: "return true;", replace: `const apiKey = "${FAKE_KEY}";\n  return true;` }])).toEqual(["secret"]);
    expect(flags([{ find: "return true;", replace: "return '\u0001';" }])).toEqual(["binary-content"]);
    // The key itself is never part of what is stored for review.
    const v = validateEdits(output([modify("src/auth/session.ts", [{ find: "return true;", replace: `return "${FAKE_KEY}";` }])]), context, originals, facts);
    expect(v.changes[0]!.diff).toBe("");
  });

  it("rejects malformed, duplicate, existing-file and no-op changes", async () => {
    const { context, originals } = await setup();
    const v = validateEdits(
      output([
        { path: "src/routes/auth.ts", operation: "modify", reason: "r", edits: [], content: "x" },
        create("src/middleware/rate-limit.ts", "a\n"),
        create("src/middleware/rate-limit.ts", "b\n"),
        create("tests/auth.test.ts", "overwrite\n"),
        modify("src/legacy.ts", [{ find: "1", replace: "1" }]),
      ]),
      context,
      originals,
      facts,
    );
    expect(v.changes.map((c) => c.flags)).toEqual([["malformed-change"], [], ["duplicate-change"], ["file-exists"], ["out-of-scope"]]);
    const noop = validateEdits(output([modify("tests/auth.test.ts", [{ find: "logs in", replace: "logs in" }])]), context, originals, facts);
    expect(noop.changes[0]).toMatchObject({ status: "rejected", flags: ["no-op"] });
    expect(noop.report.status).toBe("WARNINGS");
  });

  it("does not edit files it did not show, and enforces size limits", async () => {
    const { context, originals } = await setup();
    expect(validateEdits(output([modify("src/big.ts", [{ find: "big", replace: "large" }])]), context, originals, facts).changes[0]!.flags).toEqual(["not-in-context"]);
    const huge = "x".repeat(EDIT_LIMITS.resultFileBytes + 1);
    expect(validateEdits(output([create("src/middleware/rate-limit.ts", huge)]), context, originals, facts).changes[0]!.flags).toEqual(["too-large"]);
    const many = Array.from({ length: EDIT_LIMITS.changedLines + 1 }, (_, i) => `l${i}`).join("\n");
    expect(validateEdits(output([create("src/middleware/rate-limit.ts", many)]), context, originals, facts).changes[0]!.flags).toEqual(["too-many-lines"]);
  });

  it("refuses files with mixed line endings rather than guessing", async () => {
    const mixed = { ...FILES, "src/legacy.ts": { kind: "SOURCE" as const, text: "a\r\nb\nc\r\n" } };
    const p = plan({ affectedFiles: [file("src/legacy.ts", "modify")] });
    const { context, originals } = await buildEditContext({ task: { request: "t", constraints: [] }, plan: p, scope: deriveEditScope(p, facts), facts, readFile: async (x) => mixed[x as keyof typeof mixed]?.text ?? null });
    expect(validateEdits(output([modify("src/legacy.ts", [{ find: "b", replace: "B" }])]), context, originals, facts).changes[0]!.flags).toEqual(["mixed-line-endings"]);
  });

  it("scrubs commands and credentials from prose and rejects output that does not match the schema", async () => {
    const { context, originals } = await setup();
    const v = validateEdits(output([], { summary: "Run npm install express-rate-limit first.", notes: [`Token: api_key = "${FAKE_KEY}"`] }), context, originals, facts);
    expect(v.summary).toBe("[shell command removed by validation]");
    expect(v.notes[0]).not.toContain(FAKE_KEY);
    expect(v.report.issues.map((i) => i.code).sort()).toEqual(["command", "secret"]);
    const bad = validateEdits({ changes: "edit everything" }, context, originals, facts);
    expect(bad.report.status).toBe("REJECTED");
    expect(bad.changes).toEqual([]);
  });
});

// ---------------------------------------------------------------- checks of the result

describe("checkChanges", () => {
  it("rejects changes that break the syntax or introduce a security finding, and not pre-existing ones", async () => {
    const { context, originals } = await setup();
    const v = validateEdits(
      output([
        modify("src/routes/auth.ts", [{ find: 'authRouter.post("/login", login);', replace: 'authRouter.post("/login", login;' }]),
        create("src/middleware/rate-limit.ts", "export function rateLimit(input: string) {\n  return eval(input);\n}\n"),
        modify("tests/auth.test.ts", [{ find: "logs in", replace: "signs in" }]),
      ]),
      context,
      originals,
      facts,
    );
    expect(v.report.accepted).toBe(3);
    const issues = await checkChanges(v.changes);
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ["src/routes/auth.ts", "syntax-error"],
      ["src/middleware/rate-limit.ts", "insecure-change"],
    ]);
    expect(v.changes.map((c) => c.status)).toEqual(["rejected", "rejected", "accepted"]);
  });

  it("does not count findings that only moved", async () => {
    const before = 'export function run(code: string) {\n  return eval(code);\n}\n';
    const after = `// header\n\n${before}`;
    const change = { path: "src/run.ts", operation: "modify" as const, reason: "r", status: "accepted" as const, flags: [], before, after, diff: "x", additions: 2, deletions: 0 };
    expect(await checkChanges([change])).toEqual([]);
  });
});

// ---------------------------------------------------------------- runner and providers

describe("runEditor", () => {
  it("returns validated, checked changes with provider metadata", async () => {
    const { context, originals } = await setup();
    const provider = new ScriptedProvider([output([modify("tests/auth.test.ts", [{ find: "logs in", replace: "signs in" }])])]);
    const r = await runEditor(context, originals, provider, facts, { check: checkChanges });
    expect(r).toMatchObject({ ok: true, report: { status: "PASSED", accepted: 1 }, meta: { provider: "scripted", inputTokens: 100, outputTokens: 50 } });
    expect(provider.editCalls).toEqual([context]);
  });

  it("fails cleanly on provider errors and on output that does not match the schema", async () => {
    const { context, originals } = await setup();
    expect(await runEditor(context, originals, new ScriptedProvider([new ProviderError("refused", "The model declined to make this change.")]), facts)).toMatchObject({
      ok: false,
      reason: "refused",
      message: "The model declined to make this change.",
    });
    expect(await runEditor(context, originals, new ScriptedProvider([{ diff: "+hack" }]), facts)).toMatchObject({ ok: false, reason: "invalid-output", report: { status: "REJECTED" } });
  });
});

describe("edit providers", () => {
  const message = (text: string, stop_reason = "end_turn") => ({ id: "m", type: "message", role: "assistant", model: "claude-test", content: [{ type: "text", text }], stop_reason, usage: { input_tokens: 10, output_tokens: 5 } });

  it("asks Anthropic for schema-constrained edits with the cached system prompt, sending only the context", async () => {
    const { context } = await setup();
    const calls: Array<Record<string, any>> = [];
    const client = { beta: { messages: { create: async (params: Record<string, any>) => (calls.push(params), message(JSON.stringify(output([])))) } } } as unknown as AnthropicClientLike;
    const result = await new AnthropicProvider({ client }).generateEdits(context);
    expect(result).toMatchObject({ model: "claude-test", inputTokens: 10, outputTokens: 5, output: { changes: [] } });
    const p = calls[0]!;
    expect(p.max_tokens).toBe(32000);
    expect(p.system).toEqual([{ type: "text", text: EDITOR_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(p.output_config.format.type).toBe("json_schema");
    expect(Object.keys(p.output_config.format.schema.properties)).toEqual(["summary", "changes", "notes", "confidence"]);
    expect(p.messages).toEqual([{ role: "user", content: buildEditUserMessage(context) }]);
    expect(JSON.stringify(p)).not.toContain(FAKE_KEY);
  });

  it("maps refusals and truncation to user-safe errors", async () => {
    const { context } = await setup();
    const reply = (m: unknown) => ({ beta: { messages: { create: async () => m } } }) as unknown as AnthropicClientLike;
    await expect(new AnthropicProvider({ client: reply(message("", "refusal")) }).generateEdits(context)).rejects.toMatchObject({ reason: "refused", message: "The model declined to make this change." });
    await expect(new AnthropicProvider({ client: reply(message("{", "max_tokens")) }).generateEdits(context)).rejects.toMatchObject({ reason: "truncated", message: "The change exceeded the output limit and was cut off." });
    const failing = { beta: { messages: { create: async () => Promise.reject(new Anthropic.APIConnectionError({ message: "down" })) } } } as unknown as AnthropicClientLike;
    await expect(new AnthropicProvider({ client: failing }).generateEdits(context)).rejects.toMatchObject({ reason: "api-error" });
  });

  it("requires a model for editing: the baseline can plan but not write code", () => {
    expect(() => createEditProvider({ AI_PROVIDER: "baseline" })).toThrow(/cannot write code/);
    expect(() => createEditProvider({ AI_PROVIDER: "anthropic" })).toThrow(ProviderError);
    expect(createEditProvider({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key-not-used" }).name).toBe("anthropic");
  });
});

// Keeps the fixture honest: the context type is what the prompt builder consumes.
export type _Context = EditContext;
