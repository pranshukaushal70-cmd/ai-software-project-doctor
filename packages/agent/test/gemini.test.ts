import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  createEditProvider,
  createProvider,
  EDITOR_SYSTEM_PROMPT,
  GeminiProvider,
  inlineSchemaRefs,
  PLANNER_SYSTEM_PROMPT,
  ProviderError,
  runPlanner,
  type EditContext,
  type FetchLike,
  type PlanningContext,
  type RequestCounter,
} from "../src";

// Every test talks to a fake fetch: no request ever reaches Google.

const KEY = "gemini-test-key-never-sent-anywhere";
const URL_PLAN = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";

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

/** A generateContent body as Gemini returns it: a thought part, then the answer. */
const responseBody = (text: string, finishReason = "STOP", extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: "model", parts: [{ text: "Thinking about the plan…", thought: true }, { text }] }, finishReason }],
  usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300, thoughtsTokenCount: 500, totalTokenCount: 2000 },
  modelVersion: "gemini-3.8-flash",
  ...extra,
});

/** Google's error body: { error: { code, message, status, details } }. */
const googleError = (code: number, status: string, message: string, reason?: string) => ({
  status: code,
  body: { error: { code, message, status, ...(reason ? { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com" }] } : {}) } },
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(respond: () => { status?: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const r = respond();
    if (r instanceof Error) throw r;
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

const provider = (fetch: FetchLike, opts: { maxRequests?: number | null; counter?: RequestCounter; model?: string } = {}) =>
  new GeminiProvider({ apiKey: KEY, model: opts.model, fetch, counter: opts.counter ?? { used: 0 }, maxRequests: opts.maxRequests });

const failure = async (p: Promise<unknown>) => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
};

describe("Gemini provider: successful responses", () => {
  it("plans with generateContent, a JSON schema without $defs, and the key only in the x-goog-api-key header", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: responseBody(JSON.stringify(PLAN_JSON)) }));
    const result = await provider(fetch).generatePlan(PLAN_CTX);

    // The thought part is skipped; thinking tokens count as output.
    expect(result).toEqual({ output: PLAN_JSON, model: "gemini-3.8-flash", inputTokens: 1200, outputTokens: 800, stopReason: "STOP" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(URL_PLAN);
    expect(call.url).not.toContain(KEY);
    expect(call.headers).toEqual({ "Content-Type": "application/json", "x-goog-api-key": KEY });
    expect(call.body).toMatchObject({
      systemInstruction: { parts: [{ text: PLANNER_SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: expect.stringContaining("Add a subtract(a, b) function") }] }],
      generationConfig: { responseMimeType: "application/json", maxOutputTokens: 16000, responseJsonSchema: expect.objectContaining({ type: "object" }) },
    });
    const schema = JSON.stringify((call.body.generationConfig as { responseJsonSchema: unknown }).responseJsonSchema);
    expect(schema).not.toMatch(/\$defs|\$ref/);
    expect(JSON.stringify(call.body)).not.toContain(KEY);
  });

  it("proposes edits with the editor prompt, the change schema and the larger output budget", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: responseBody('{"changes":[]}') }));
    expect((await provider(fetch).generateEdits(EDIT_CTX)).output).toEqual({ changes: [] });
    expect(calls[0]!.body).toMatchObject({ systemInstruction: { parts: [{ text: EDITOR_SYSTEM_PROMPT }] }, generationConfig: { maxOutputTokens: 32000 } });
    expect(JSON.stringify(calls[0]!.body.contents)).toContain("exports.add");
  });

  it("uses GEMINI_MODEL in the path and reports the model version that answered", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: responseBody("{}", "STOP", { modelVersion: "gemini-3.5-flash-lite-001" }) }));
    const result = await provider(fetch, { model: "gemini-3.5-flash-lite" }).generatePlan(PLAN_CTX);
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(result.model).toBe("gemini-3.5-flash-lite-001");
  });

  it("joins an answer split over several parts", async () => {
    const body = responseBody("");
    body.candidates[0]!.content.parts = [{ text: '{"taskSummary":' }, { text: '"Add subtract."}' }] as never;
    expect((await provider(fakeFetch(() => ({ body })).fetch).generatePlan(PLAN_CTX)).output).toEqual(PLAN_JSON);
  });
});

describe("Gemini provider: malformed output", () => {
  const reason = async (respond: Parameters<typeof fakeFetch>[0]) => (await failure(provider(fakeFetch(respond).fetch).generatePlan(PLAN_CTX))).reason;

  it("rejects text that is not JSON, empty answers and missing candidates", async () => {
    expect(await reason(() => ({ body: responseBody("Sure! Here is your plan.") }))).toBe("invalid-json");
    expect(await reason(() => ({ body: responseBody("") }))).toBe("invalid-json");
    expect(await reason(() => ({ body: responseBody('{"taskSummary": "cut', "MALFORMED_RESPONSE") }))).toBe("invalid-json");
    expect(await reason(() => ({ body: { candidates: [] } }))).toBe("invalid-json");
    expect(await reason(() => ({ body: "<html>Bad gateway</html>" }))).toBe("api-error");
  });

  it("reports cut-off output as truncated and blocked prompts or answers as refusals", async () => {
    expect(await reason(() => ({ body: responseBody('{"taskSummary":', "MAX_TOKENS") }))).toBe("truncated");
    expect(await reason(() => ({ body: responseBody("", "SAFETY") }))).toBe("refused");
    expect(await reason(() => ({ body: responseBody("", "RECITATION") }))).toBe("refused");
    expect(await reason(() => ({ body: responseBody("", "PROHIBITED_CONTENT") }))).toBe("refused");
    expect(await reason(() => ({ body: { promptFeedback: { blockReason: "SAFETY" } } }))).toBe("refused");
  });
});

describe("Gemini provider: authentication errors, rate limits and network failures", () => {
  it("treats an invalid key (400 API_KEY_INVALID), 401 and 403 as configuration problems", async () => {
    for (const r of [
      googleError(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", "API_KEY_INVALID"),
      googleError(401, "UNAUTHENTICATED", "Request had invalid authentication credentials."),
      googleError(403, "PERMISSION_DENIED", "Method doesn't allow unregistered callers."),
    ]) {
      const err = await failure(provider(fakeFetch(() => r).fetch).generatePlan(PLAN_CTX));
      expect(err.reason).toBe("not-configured");
      expect(err.message).toBe("The AI provider rejected the request: check the API key and its permissions.");
    }
    // Other 400s (e.g. a schema the API rejects) are API errors, with Google's text for the log.
    const bad = await failure(provider(fakeFetch(() => googleError(400, "INVALID_ARGUMENT", "Invalid JSON payload: unknown field")).fetch).generatePlan(PLAN_CTX));
    expect(bad).toMatchObject({ reason: "api-error", message: "The AI provider returned an error (400).", detail: { status: 400, type: "INVALID_ARGUMENT", message: "Invalid JSON payload: unknown field" } });
  });

  it("maps 429 RESOURCE_EXHAUSTED (rate limit or free-tier quota) to rate-limited, without retrying", async () => {
    const { fetch, calls } = fakeFetch(() => googleError(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota."));
    const err = await failure(provider(fetch).generatePlan(PLAN_CTX));
    expect(err.reason).toBe("rate-limited");
    expect(err.message).toMatch(/quota/);
    expect(err.detail).toMatchObject({ status: 429, type: "RESOURCE_EXHAUSTED" });
    expect(calls).toHaveLength(1);
  });

  it("maps network failures and timeouts to a safe message without detail, and 5xx to an API error, each tried once", async () => {
    for (const thrown of [new TypeError("fetch failed"), new DOMException("The operation timed out.", "TimeoutError")]) {
      const { fetch, calls } = fakeFetch(() => thrown);
      const err = await failure(provider(fetch).generatePlan(PLAN_CTX));
      expect(err).toMatchObject({ reason: "api-error", message: "The AI provider could not be reached.", detail: null });
      expect(calls).toHaveLength(1);
    }
    const { fetch, calls } = fakeFetch(() => googleError(503, "UNAVAILABLE", "The model is overloaded."));
    expect((await failure(provider(fetch).generatePlan(PLAN_CTX))).message).toBe("The AI provider returned an error (503).");
    expect(calls).toHaveLength(1);
  });

  it("removes the key from logged error text and never puts it in the user message", async () => {
    const { fetch } = fakeFetch(() => googleError(400, "INVALID_ARGUMENT", `API key not valid: ${KEY}. ${"x".repeat(500)}`, "API_KEY_INVALID"));
    const err = await failure(provider(fetch).generatePlan(PLAN_CTX));
    expect(err.detail!.message).toMatch(/^API key not valid: <redacted>\. x+$/);
    expect(err.detail!.message!.length).toBe(300);
    expect(JSON.stringify({ message: err.message, detail: err.detail })).not.toContain(KEY);

    // runPlanner hands the failure and its detail to the worker log.
    const facts = { files: new Map([["src/math.js", "SOURCE" as const]]), hasSymbol: () => false };
    expect(await runPlanner(PLAN_CTX, provider(fetch), facts)).toMatchObject({ ok: false, reason: "not-configured", meta: { provider: "gemini", model: "gemini-3.8-flash" }, detail: { status: 400 } });
  });

  it("stops at AI_MAX_REQUESTS before calling the API, counting failed requests too", async () => {
    const counter = { used: 0 };
    const { fetch, calls } = fakeFetch(() => googleError(429, "RESOURCE_EXHAUSTED", "quota"));
    await failure(provider(fetch, { maxRequests: 1, counter }).generatePlan(PLAN_CTX));
    const capped = await failure(provider(fetch, { maxRequests: 1, counter }).generateEdits(EDIT_CTX));
    expect(capped.message).toMatch(/AI_MAX_REQUESTS/);
    expect(calls).toHaveLength(1);
  });

  it("keeps the key out of the provider's enumerable fields, JSON and inspection", () => {
    const p = provider(fakeFetch(() => ({ body: responseBody("{}") })).fetch);
    expect(JSON.stringify(p)).not.toContain(KEY);
    expect(inspect(p, { depth: 5, showHidden: true })).not.toContain(KEY);
  });
});

describe("Gemini schema and configuration", () => {
  it("inlines $defs references exactly and refuses recursive or unknown ones", () => {
    const schema = { type: "object", properties: { a: { $ref: "#/$defs/Claim" }, b: { type: "array", items: { $ref: "#/$defs/Claim", description: "kept" } } }, $defs: { Claim: { type: "object", properties: { s: { type: "string" } } } } };
    expect(inlineSchemaRefs(schema)).toEqual({
      type: "object",
      properties: { a: { type: "object", properties: { s: { type: "string" } } }, b: { type: "array", items: { type: "object", properties: { s: { type: "string" } }, description: "kept" } } },
    });
    expect(() => inlineSchemaRefs({ $ref: "#/$defs/A", $defs: { A: { items: { $ref: "#/$defs/A" } } } })).toThrow(/Recursive/);
    expect(() => inlineSchemaRefs({ $ref: "#/$defs/Missing" })).toThrow(/Unresolvable/);
  });

  it("is chosen with AI_PROVIDER=gemini, defaults to gemini-3.8-flash and accepts the models/ prefix", () => {
    const p = createProvider({ AI_PROVIDER: "gemini", GEMINI_API_KEY: ` ${KEY}\n` });
    expect({ name: p.name, model: p.model }).toEqual({ name: "gemini", model: "gemini-3.8-flash" });
    expect(createProvider({ AI_PROVIDER: "gemini", GEMINI_API_KEY: KEY, GEMINI_MODEL: "models/gemini-3.5-flash-lite" }).model).toBe("gemini-3.5-flash-lite");
    expect(createEditProvider({ AI_PROVIDER: "Gemini", GEMINI_API_KEY: KEY }).name).toBe("gemini");
    expect(inspect(p, { depth: 5, showHidden: true })).not.toContain(KEY);
  });

  it("requires a key and validates the model code and request cap", () => {
    expect(() => createProvider({ AI_PROVIDER: "gemini" })).toThrow(/needs GEMINI_API_KEY/);
    expect(() => createProvider({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "  " })).toThrow(/needs GEMINI_API_KEY/);
    expect(() => createProvider({ AI_PROVIDER: "gemini", GEMINI_API_KEY: KEY, GEMINI_MODEL: "../evil?key=x" })).toThrow(/GEMINI_MODEL/);
    expect(() => createProvider({ AI_PROVIDER: "gemini", GEMINI_API_KEY: KEY, AI_MAX_REQUESTS: "lots" })).toThrow(/AI_MAX_REQUESTS/);
  });

  it("leaves the other providers unchanged when a Gemini key is present", () => {
    expect(createProvider({ AI_PROVIDER: "baseline", GEMINI_API_KEY: KEY }).name).toBe("baseline");
    expect(createProvider({ ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: KEY }).name).toBe("anthropic");
    expect(createProvider({ AI_PROVIDER: "xai", XAI_API_KEY: "x", XAI_MODEL: "grok-4.3", GEMINI_API_KEY: KEY }).name).toBe("xai");
  });
});
