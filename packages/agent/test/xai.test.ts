import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createEditProvider,
  createProvider,
  EDITOR_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  ProviderError,
  providerEnvFrom,
  runPlanner,
  XaiProvider,
  type EditContext,
  type FetchLike,
  type PlanningContext,
  type RequestCounter,
} from "../src";

// Every test talks to a fake fetch: no request ever reaches xAI.

const KEY = "xai-test-key-never-sent-anywhere";

const PLAN_CTX: PlanningContext = {
  task: { request: "Add a subtract(a, b) function", scope: null, constraints: [] },
  repository: { name: "tiny", primaryLanguage: "javascript", languages: ["javascript"], frameworks: [], testFrameworks: ["node:test"], packageManagers: ["npm"], runtimes: ["node"] },
  evidence: [{ id: "E1", kind: "FILE", path: "src/math.js", symbol: null, line: null, summary: "Exports add(a, b).", source: "search" }],
  stats: { searchHits: 1, candidateFiles: 1, evidence: 1, truncated: false },
};

const EDIT_CTX: EditContext = {
  task: { request: "Add a subtract(a, b) function", constraints: [] },
  plan: { summary: "Add subtract.", interpretation: "A new export.", steps: [{ title: "Add it", description: "Add subtract to src/math.js.", files: ["src/math.js"] }], tests: [], dependencyChanges: [], configurationChanges: [] },
  scope: { modify: ["src/math.js"], create: [], delete: [], newTests: false, dependencyChanges: false },
  files: [{ path: "src/math.js", purpose: "modify", content: "exports.add = (a, b) => a + b;\n", redacted: false }],
  omitted: [],
  repair: null,
  stats: { files: 1, bytes: 31, truncated: false },
};

const PLAN_JSON = { taskSummary: "Add subtract." };

/** A Responses API body as xAI returns it: a reasoning item, then the message. */
const responseBody = (text: string, extra: Record<string, unknown> = {}) => ({
  id: "resp_1",
  object: "response",
  model: "grok-4.3",
  status: "completed",
  output: [
    { type: "reasoning", id: "rs_1", summary: [] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  ],
  usage: { input_tokens: 1200, output_tokens: 300, output_tokens_details: { reasoning_tokens: 500 }, total_tokens: 2000 },
  ...extra,
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fake fetch answering every call with `respond` (a body and status, or a thrown error). */
function fakeFetch(respond: () => { status?: number; body: unknown; headers?: Record<string, string> } | Error) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const r = respond();
    if (r instanceof Error) throw r;
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status ?? 200, headers: { "content-type": "application/json", ...r.headers } });
  };
  return { fetch, calls };
}

const provider = (fetch: FetchLike, opts: { maxRequests?: number | null; counter?: RequestCounter; baseUrl?: string } = {}) =>
  new XaiProvider({ apiKey: KEY, model: "grok-4.3", fetch, counter: opts.counter ?? { used: 0 }, maxRequests: opts.maxRequests, baseUrl: opts.baseUrl });

const failure = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
};

describe("xAI provider", () => {
  it("plans through the Responses API with strict JSON-schema output, the key only in the Authorization header, and no stored prompt", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: responseBody(JSON.stringify(PLAN_JSON)) }));
    const result = await provider(fetch).generatePlan(PLAN_CTX);

    expect(result).toEqual({ output: PLAN_JSON, model: "grok-4.3", inputTokens: 1200, outputTokens: 800, stopReason: "completed" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.x.ai/v1/responses");
    expect(call.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${KEY}` });
    expect(call.body).toMatchObject({
      model: "grok-4.3",
      max_output_tokens: 16000,
      store: false,
      text: { format: { type: "json_schema", name: "plan", strict: true, schema: expect.objectContaining({ type: "object" }) } },
    });
    expect(call.body.input).toEqual([
      { role: "system", content: PLANNER_SYSTEM_PROMPT },
      { role: "user", content: expect.stringContaining("Add a subtract(a, b) function") },
    ]);
    expect(JSON.stringify(call.body)).not.toContain(KEY);
  });

  it("proposes edits with the editor prompt, the change schema and the larger output budget", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: responseBody('{"changes":[]}') }));
    const result = await provider(fetch).generateEdits(EDIT_CTX);

    expect(result.output).toEqual({ changes: [] });
    expect(calls[0]!.body).toMatchObject({ max_output_tokens: 32000, text: { format: { type: "json_schema", name: "change", strict: true } } });
    expect((calls[0]!.body.input as Array<{ content: string }>)[0]!.content).toBe(EDITOR_SYSTEM_PROMPT);
    expect((calls[0]!.body.input as Array<{ content: string }>)[1]!.content).toContain("exports.add");
  });

  it("uses XAI_BASE_URL when given, without a doubled slash", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: responseBody("{}") }));
    await provider(fetch, { baseUrl: "http://model-stub:4010/v1/" }).generatePlan(PLAN_CTX);
    expect(calls[0]!.url).toBe("http://model-stub:4010/v1/responses");
  });

  it("turns refusals, truncation, invalid JSON and HTTP errors into safe provider errors", async () => {
    const reason = async (respond: Parameters<typeof fakeFetch>[0]) => (await failure(provider(fakeFetch(respond).fetch).generatePlan(PLAN_CTX))).reason;
    const message = (content: unknown[]) => ({ body: responseBody("", { output: [{ type: "message", content }] }) });

    expect(await reason(() => message([{ type: "refusal", refusal: "I can't help with that." }]))).toBe("refused");
    expect(await reason(() => ({ body: responseBody('{"taskSummary":', { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }) }))).toBe("truncated");
    expect(await reason(() => ({ body: responseBody("", { status: "incomplete", incomplete_details: { reason: "content_filter" } }) }))).toBe("refused");
    expect(await reason(() => ({ body: responseBody("Sure! Here is your plan.") }))).toBe("invalid-json");
    expect(await reason(() => message([]))).toBe("invalid-json");
    expect(await reason(() => ({ status: 429, body: { error: "Too many requests" } }))).toBe("rate-limited");
    expect(await reason(() => ({ status: 401, body: { error: "Incorrect API key provided" } }))).toBe("not-configured");
    expect(await reason(() => ({ status: 403, body: { error: "Your team has no credits" } }))).toBe("not-configured");
    expect(await reason(() => ({ status: 500, body: { error: "internal" } }))).toBe("api-error");
    expect(await reason(() => ({ body: "<html>gateway</html>" }))).toBe("api-error");
    expect(await reason(() => new TypeError("fetch failed"))).toBe("api-error");
  });

  it("tells the user to check key, permissions and credits on 401/403", async () => {
    const err = await failure(provider(fakeFetch(() => ({ status: 403, body: { error: "no credits" } })).fetch).generatePlan(PLAN_CTX));
    expect(err.message).toBe("The AI provider rejected the request: check the API key, its permissions and the account's credits.");
  });

  it("keeps the API's status, type, request id and truncated message for the log, with the key removed and never in the user message", async () => {
    const long = `Incorrect API key provided: ${KEY}. ${"x".repeat(500)}`;
    const { fetch } = fakeFetch(() => ({ status: 400, body: { code: "invalid_request", error: long }, headers: { "x-request-id": "req_xai_1" } }));
    const err = await failure(provider(fetch).generatePlan(PLAN_CTX));

    expect(err.message).toBe("The AI provider returned an error (400).");
    expect(err.detail).toMatchObject({ status: 400, type: "invalid_request", requestId: "req_xai_1" });
    expect(err.detail!.message).toMatch(/^Incorrect API key provided: <redacted>\. x+$/);
    expect(err.detail!.message!.length).toBe(300);
    expect(JSON.stringify({ message: err.message, detail: err.detail })).not.toContain(KEY);

    // The OpenAI-style error shape is read too.
    const nested = await failure(provider(fakeFetch(() => ({ status: 400, body: { error: { type: "invalid_request_error", message: "bad schema" } } })).fetch).generatePlan(PLAN_CTX));
    expect(nested.detail).toMatchObject({ type: "invalid_request_error", message: "bad schema", requestId: null });

    // Network failures carry no detail; runPlanner passes API details on for the worker log.
    expect((await failure(provider(fakeFetch(() => new TypeError("fetch failed")).fetch).generatePlan(PLAN_CTX))).detail).toBeNull();
    const facts = { files: new Map([["src/math.js", "SOURCE" as const]]), hasSymbol: () => false };
    const planned = await runPlanner(PLAN_CTX, provider(fetch), facts);
    expect(planned).toMatchObject({ ok: false, reason: "api-error", meta: { provider: "xai", model: "grok-4.3" }, detail: { requestId: "req_xai_1" } });
  });

  it("never retries: one failed request is one call", async () => {
    for (const status of [429, 500, 503]) {
      const { fetch, calls } = fakeFetch(() => ({ status, body: { error: "fail" } }));
      await failure(provider(fetch).generatePlan(PLAN_CTX));
      expect(calls).toHaveLength(1);
    }
  });

  it("stops at AI_MAX_REQUESTS before calling the API, counting failed requests too", async () => {
    const counter = { used: 0 };
    let fail = false;
    const { fetch, calls } = fakeFetch(() => (fail ? { status: 500, body: { error: "fail" } } : { body: responseBody("{}") }));
    const p = provider(fetch, { maxRequests: 2, counter });

    await p.generatePlan(PLAN_CTX);
    fail = true;
    await failure(p.generateEdits(EDIT_CTX));
    const capped = await failure(p.generatePlan(PLAN_CTX));
    expect(capped.reason).toBe("rate-limited");
    expect(capped.message).toMatch(/AI_MAX_REQUESTS/);
    expect(calls).toHaveLength(2);
    expect(counter.used).toBe(2);

    // The counter is shared: a new provider in the same process (one per job) sees the same budget.
    expect((await failure(provider(fetch, { maxRequests: 2, counter }).generatePlan(PLAN_CTX))).reason).toBe("rate-limited");
    // 0 blocks every request; no limit by default.
    const none = fakeFetch(() => ({ body: responseBody("{}") }));
    await failure(provider(none.fetch, { maxRequests: 0 }).generatePlan(PLAN_CTX));
    expect(none.calls).toHaveLength(0);
    const unlimited = provider(none.fetch, { counter: { used: 1_000 } });
    await unlimited.generatePlan(PLAN_CTX);
    expect(none.calls).toHaveLength(1);
  });

  it("keeps the key out of the provider's enumerable fields, JSON and inspection", () => {
    const p = provider(fakeFetch(() => ({ body: responseBody("{}") })).fetch);
    expect(JSON.stringify(p)).not.toContain(KEY);
    expect(inspect(p, { depth: 5, showHidden: true })).not.toContain(KEY);
    expect(Object.values(p).filter((v) => typeof v === "string")).not.toContain(KEY);
  });
});

describe("xAI configuration", () => {
  const env = { AI_PROVIDER: "xai", XAI_API_KEY: ` ${KEY}\n`, XAI_MODEL: "grok-4.3" };

  it("is chosen with AI_PROVIDER=xai and plans and edits", () => {
    const p = createProvider(env);
    expect({ name: p.name, model: p.model }).toEqual({ name: "xai", model: "grok-4.3" });
    expect(createEditProvider({ ...env, AI_PROVIDER: " XAI " }).name).toBe("xai");
    expect(inspect(p, { depth: 5, showHidden: true })).not.toContain(KEY);
  });

  it("requires a key and an explicit model, and validates the base URL and request cap", () => {
    const reject = (e: Record<string, string>, re: RegExp) => expect(() => createProvider(e)).toThrow(re);
    reject({ AI_PROVIDER: "xai", XAI_MODEL: "grok-4.3" }, /needs XAI_API_KEY/);
    reject({ AI_PROVIDER: "xai", XAI_API_KEY: "  ", XAI_MODEL: "grok-4.3" }, /needs XAI_API_KEY/);
    reject({ AI_PROVIDER: "xai", XAI_API_KEY: KEY }, /needs XAI_MODEL/);
    reject({ ...env, XAI_BASE_URL: "not a url" }, /XAI_BASE_URL/);
    reject({ ...env, XAI_BASE_URL: "file:///etc/passwd" }, /XAI_BASE_URL/);
    reject({ ...env, AI_MAX_REQUESTS: "two" }, /AI_MAX_REQUESTS/);
    reject({ ...env, AI_MAX_REQUESTS: "-1" }, /AI_MAX_REQUESTS/);
    reject({ ...env, AI_MAX_REQUESTS: "1.5" }, /AI_MAX_REQUESTS/);
    expect(createProvider({ ...env, AI_MAX_REQUESTS: "1", XAI_BASE_URL: "https://api.x.ai/v1" }).name).toBe("xai");
    expect(() => createProvider({ AI_PROVIDER: "grok" })).toThrow(/use "anthropic", "xai", "gemini" or "baseline"/);
  });

  it("leaves the Anthropic and baseline providers unchanged", () => {
    expect(createProvider({ AI_PROVIDER: "baseline", XAI_API_KEY: KEY }).name).toBe("baseline");
    expect(createProvider({ ANTHROPIC_API_KEY: "k", XAI_API_KEY: KEY, XAI_MODEL: "grok-4.3" }).name).toBe("anthropic");
  });

  it("copies only the provider settings out of the process environment", () => {
    const picked = providerEnvFrom({ ...env, AI_MAX_REQUESTS: "1", JWT_SECRET: "s", DATABASE_URL: "postgres://u:p@h/db", PATH: "/bin" });
    expect(Object.keys(picked).sort()).toEqual(["AI_MAX_REQUESTS", "AI_PROVIDER", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "GEMINI_API_KEY", "GEMINI_MODEL", "XAI_API_KEY", "XAI_BASE_URL", "XAI_MODEL"]);
    expect(JSON.stringify(picked)).not.toMatch(/JWT_SECRET|postgres|\/bin/);
  });
});
