import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { buildEditUserMessage, EDITOR_SYSTEM_PROMPT } from "./edit-prompt";
import { EditOutputSchema, type EditContext } from "./edit-schema";
import { buildUserMessage, PLANNER_SYSTEM_PROMPT } from "./prompt";
import { PlanOutputSchema, type PlanOutput, type PlanningContext } from "./schema";

/**
 * LLM provider abstraction. A provider turns a planning context into raw plan
 * output; it never touches the repository and its output is treated as untrusted
 * (validated by validate.ts). Providers are replaceable: Anthropic is the default, xAI
 * (Grok) and Google Gemini are alternatives, "baseline" plans without any LLM, and tests use a
 * scripted provider.
 */

export interface ProviderResult {
  /** Parsed JSON as returned by the model: untrusted until validated. */
  output: unknown;
  /** The model that actually served the request (may differ after a fallback). */
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
}

export interface LLMProvider {
  /** Stable identifier stored with each plan, e.g. "anthropic". */
  readonly name: string;
  /** Requested model, e.g. "claude-opus-5-5". */
  readonly model: string;
  generatePlan(context: PlanningContext): Promise<ProviderResult>;
}

/**
 * A provider that can also propose code changes (Phase 8). Separate from LLMProvider
 * because the deterministic baseline can plan but cannot write code.
 */
export interface CodeEditProvider extends LLMProvider {
  /** Proposed edits for an approved plan; untrusted until validateEdits has checked them. */
  generateEdits(context: EditContext): Promise<ProviderResult>;
}

/**
 * What the AI provider's API said about a failed request, for the worker log only (never
 * stored on the plan or run, never shown to users): enough to look the request up, no
 * prompt and no key. `message` is the API's own error text, which describes the request
 * shape (e.g. an unsupported schema keyword), truncated.
 */
export interface ProviderErrorDetail {
  status: number | null;
  type: string | null;
  requestId: string | null;
  message: string | null;
}

/** A provider failure whose message is safe to store and show (no prompt, no key). */
export class ProviderError extends Error {
  constructor(
    readonly reason: "not-configured" | "refused" | "truncated" | "invalid-json" | "api-error" | "rate-limited",
    message: string,
    readonly detail: ProviderErrorDetail | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const DETAIL_MESSAGE_CHARS = 300;

/** The loggable facts of an SDK API error. */
function apiErrorDetail(err: InstanceType<typeof Anthropic.APIError>): ProviderErrorDetail {
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const message = typeof body?.error?.message === "string" ? body.error.message.slice(0, DETAIL_MESSAGE_CHARS) : null;
  return { status: err.status ?? null, type: err.type ?? null, requestId: err.requestID ?? null, message };
}

// ---------------------------------------------------------------- Anthropic

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
/** Per-request timeouts. Explicit, so the SDK's non-streaming guard (10 min for 32k tokens) does not apply. */
export const PLAN_TIMEOUT_MS = 5 * 60 * 1000;
export const EDIT_TIMEOUT_MS = 10 * 60 * 1000;
const PLAN_FORMAT = zodOutputFormat(PlanOutputSchema);
const EDIT_FORMAT = zodOutputFormat(EditOutputSchema);

/** The subset of the SDK client the provider uses; tests inject a fake. */
export type AnthropicClientLike = { beta: { messages: { create: Anthropic["beta"]["messages"]["create"] } } };

export class AnthropicProvider implements CodeEditProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: AnthropicClientLike;

  constructor(opts: { apiKey?: string; model?: string; client?: AnthropicClientLike } = {}) {
    this.model = opts.model || DEFAULT_ANTHROPIC_MODEL;
    // The key is only handed to the SDK; it is never logged, stored or returned.
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: PLAN_TIMEOUT_MS });
  }

  generatePlan(context: PlanningContext): Promise<ProviderResult> {
    return this.request({ system: PLANNER_SYSTEM_PROMPT, user: buildUserMessage(context), schema: PLAN_FORMAT.schema, maxTokens: 16000, what: "plan" });
  }

  generateEdits(context: EditContext): Promise<ProviderResult> {
    // Edits carry whole new files and replacement blocks: a larger output budget than plans,
    // and so more time per (non-streaming) request. One retry, not two: three timed-out
    // attempts would outlast the run's default time budget.
    return this.request({
      system: EDITOR_SYSTEM_PROMPT,
      user: buildEditUserMessage(context),
      schema: EDIT_FORMAT.schema,
      maxTokens: 32000,
      what: "change",
      options: { timeout: EDIT_TIMEOUT_MS, maxRetries: 1 },
    });
  }

  /** One structured-output request; failures become ProviderErrors with user-safe messages. */
  private async request(r: {
    system: string;
    user: string;
    schema: Record<string, unknown>;
    maxTokens: number;
    what: "plan" | "change";
    options?: { timeout: number; maxRetries: number };
  }): Promise<ProviderResult> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = (await this.client.beta.messages.create(
        {
          model: this.model,
          max_tokens: r.maxTokens,
          // A safety-classifier decline is retried server-side on Anthropic's recommended fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "high", format: { type: "json_schema", schema: r.schema } },
          system: [{ type: "text", text: r.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: r.user }],
        },
        r.options,
      )) as Anthropic.Beta.BetaMessage;
    } catch (err) {
      const detail = err instanceof Anthropic.APIError ? apiErrorDetail(err) : null;
      if (err instanceof Anthropic.RateLimitError) throw new ProviderError("rate-limited", "The AI provider is rate limiting requests; try again later.", detail);
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new ProviderError("not-configured", "The AI provider rejected the configured credentials.", detail);
      }
      if (err instanceof Anthropic.APIError) throw new ProviderError("api-error", `The AI provider returned an error (${err.status ?? "network"}).`, detail);
      throw new ProviderError("api-error", "The AI provider could not be reached.");
    }
    const usage = { inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null };
    if (response.stop_reason === "refusal") throw new ProviderError("refused", r.what === "plan" ? "The model declined to plan this task." : "The model declined to make this change.");
    if (response.stop_reason === "max_tokens") throw new ProviderError("truncated", `The ${r.what} exceeded the output limit and was cut off.`);
    const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new ProviderError("invalid-json", "The model did not return valid JSON.");
    }
    return { output, model: response.model, ...usage, stopReason: response.stop_reason };
  }
}

// ---------------------------------------------------------------- xAI (Grok)

export const XAI_BASE_URL = "https://api.x.ai/v1";

/** Requests a process has sent to a metered provider (xAI, Gemini), counted against AI_MAX_REQUESTS; a restart resets it. */
export interface RequestCounter {
  used: number;
}
const meteredRequests: RequestCounter = { used: 0 };

/** Takes one request from the AI_MAX_REQUESTS budget, or refuses before anything is sent. */
function takeRequest(counter: RequestCounter, maxRequests: number | null) {
  if (maxRequests !== null && counter.used >= maxRequests) {
    throw new ProviderError("rate-limited", "The AI request limit for this server (AI_MAX_REQUESTS) has been reached; restart the worker to allow more.");
  }
  // Counted before sending: a request that fails after reaching the API may still be billed or use quota.
  counter.used += 1;
}

/** An API error message for the log: the key removed (some APIs echo it), truncated. */
function redactedDetailMessage(message: string | null, apiKey: string): string | null {
  if (!message) return null;
  return (apiKey ? message.split(apiKey).join("<redacted>") : message).slice(0, DETAIL_MESSAGE_CHARS);
}

/** The subset of `fetch` the providers use; tests inject a fake. */
export type FetchLike = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

interface XaiResponse {
  model?: string;
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
  usage?: { input_tokens?: number; output_tokens?: number; output_tokens_details?: { reasoning_tokens?: number } };
}

/**
 * xAI's Responses API (`POST /v1/responses`, the interface xAI recommends) with strict JSON-schema
 * output. Every request costs money, so it is never retried, and `maxRequests` (AI_MAX_REQUESTS)
 * caps how many this process may send. `store: false`: xAI does not keep the prompt, which
 * carries repository code.
 */
export class XaiProvider implements CodeEditProvider {
  readonly name = "xai";
  readonly model: string;
  /** A real private field: not enumerable, not serialised, not shown when the provider is inspected or logged. */
  readonly #apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRequests: number | null;
  private readonly fetch: FetchLike;
  private readonly counter: RequestCounter;

  constructor(opts: { apiKey: string; model: string; baseUrl?: string; maxRequests?: number | null; fetch?: FetchLike; counter?: RequestCounter }) {
    this.model = opts.model;
    // The key is only sent in the Authorization header; it is never logged, stored or returned.
    this.#apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl || XAI_BASE_URL).replace(/\/+$/, "");
    this.maxRequests = opts.maxRequests ?? null;
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.counter = opts.counter ?? meteredRequests;
  }

  generatePlan(context: PlanningContext): Promise<ProviderResult> {
    return this.request({ system: PLANNER_SYSTEM_PROMPT, user: buildUserMessage(context), schema: PLAN_FORMAT.schema, maxTokens: 16000, what: "plan", timeoutMs: PLAN_TIMEOUT_MS });
  }

  generateEdits(context: EditContext): Promise<ProviderResult> {
    return this.request({ system: EDITOR_SYSTEM_PROMPT, user: buildEditUserMessage(context), schema: EDIT_FORMAT.schema, maxTokens: 32000, what: "change", timeoutMs: EDIT_TIMEOUT_MS });
  }

  private async request(r: { system: string; user: string; schema: Record<string, unknown>; maxTokens: number; what: "plan" | "change"; timeoutMs: number }): Promise<ProviderResult> {
    takeRequest(this.counter, this.maxRequests);
    let res: Response;
    try {
      res = await this.fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({
          model: this.model,
          input: [
            { role: "system", content: r.system },
            { role: "user", content: r.user },
          ],
          max_output_tokens: r.maxTokens,
          text: { format: { type: "json_schema", name: r.what === "plan" ? "plan" : "change", schema: r.schema, strict: true } },
          store: false,
        }),
        signal: AbortSignal.timeout(r.timeoutMs),
      });
    } catch {
      throw new ProviderError("api-error", "The AI provider could not be reached.");
    }
    const raw = await res.text().catch(() => "");
    if (!res.ok) {
      const detail = this.errorDetail(res, raw);
      if (res.status === 429) throw new ProviderError("rate-limited", "The AI provider is rate limiting requests; try again later.", detail);
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError("not-configured", "The AI provider rejected the request: check the API key, its permissions and the account's credits.", detail);
      }
      throw new ProviderError("api-error", `The AI provider returned an error (${res.status}).`, detail);
    }
    let body: XaiResponse;
    try {
      body = JSON.parse(raw) as XaiResponse;
    } catch {
      throw new ProviderError("api-error", "The AI provider returned an unreadable response.");
    }
    const reasoning = body.usage?.output_tokens_details?.reasoning_tokens ?? 0;
    // Reasoning tokens are billed as output but reported separately from output_tokens.
    const usage = { inputTokens: body.usage?.input_tokens ?? null, outputTokens: body.usage?.output_tokens != null ? body.usage.output_tokens + reasoning : null };
    const parts = (body.output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
    if (parts.some((p) => p.type === "refusal")) throw new ProviderError("refused", r.what === "plan" ? "The model declined to plan this task." : "The model declined to make this change.");
    if (body.status === "incomplete") {
      if (body.incomplete_details?.reason === "content_filter") throw new ProviderError("refused", r.what === "plan" ? "The model declined to plan this task." : "The model declined to make this change.");
      throw new ProviderError("truncated", `The ${r.what} exceeded the output limit and was cut off.`);
    }
    const text = parts.map((p) => (p.type === "output_text" ? (p.text ?? "") : "")).join("");
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new ProviderError("invalid-json", "The model did not return valid JSON.");
    }
    return { output, model: body.model || this.model, ...usage, stopReason: body.status ?? null };
  }

  /** The loggable facts of an error response: status, error type, request id and the API's message (truncated, key removed). */
  private errorDetail(res: Response, raw: string): ProviderErrorDetail {
    let type: string | null = null;
    let message: string | null = null;
    try {
      const b = JSON.parse(raw) as { code?: unknown; error?: unknown };
      const err = b.error as { message?: unknown; type?: unknown; code?: unknown } | string | undefined;
      if (typeof err === "string") message = err;
      else if (err && typeof err === "object") {
        if (typeof err.message === "string") message = err.message;
        if (typeof err.type === "string") type = err.type;
        else if (typeof err.code === "string") type = err.code;
      }
      if (!type && typeof b.code === "string") type = b.code;
    } catch {
      message = raw || null;
    }
    message = redactedDetailMessage(message, this.#apiKey);
    const requestId = res.headers.get("x-request-id") ?? res.headers.get("request-id");
    return { status: res.status, type, requestId, message };
  }
}

// ---------------------------------------------------------------- Google Gemini

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** Stable, structured outputs, on the Gemini API free tier (ai.google.dev/gemini-api/docs/models). */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

/**
 * The schema with every local `$ref` replaced by its `$defs` entry. Gemini documents `$ref`
 * support, but `$defs` has been reported rejected or expanded unpredictably; our schemas are
 * not recursive, so inlining them is exact.
 */
export function inlineSchemaRefs(schema: Record<string, unknown>): Record<string, unknown> {
  const defs = (schema.$defs ?? {}) as Record<string, unknown>;
  const resolve = (node: unknown, seen: readonly string[]): unknown => {
    if (Array.isArray(node)) return node.map((n) => resolve(n, seen));
    if (!node || typeof node !== "object") return node;
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string") {
      const name = /^#\/\$defs\/(.+)$/.exec(obj.$ref)?.[1];
      if (!name || !(name in defs)) throw new Error(`Unresolvable schema reference ${obj.$ref}`);
      if (seen.includes(name)) throw new Error(`Recursive schema reference ${obj.$ref}`);
      const { $ref: _ref, ...siblings } = obj;
      return { ...(resolve(defs[name], [...seen, name]) as object), ...(resolve(siblings, seen) as object) };
    }
    return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== "$defs").map(([k, v]) => [k, resolve(v, seen)]));
  };
  return resolve(schema, []) as Record<string, unknown>;
}

/** Inlined once, on first use: a schema problem then affects Gemini requests only, never module loading. */
const geminiSchemas: { plan?: Record<string, unknown>; change?: Record<string, unknown> } = {};
const geminiSchema = (what: "plan" | "change") =>
  (geminiSchemas[what] ??= inlineSchemaRefs(what === "plan" ? PLAN_FORMAT.schema : EDIT_FORMAT.schema));
/** Finish reasons meaning the model or its safety filters declined to answer. */
const GEMINI_REFUSALS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "LANGUAGE"]);

interface GeminiResponse {
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/**
 * Google's Gemini API (`models.generateContent`, which Google states remains fully supported)
 * with JSON-schema output (`responseJsonSchema`). The key goes in the `x-goog-api-key` header,
 * never the URL. Free-tier quotas are per request, so it is never retried and AI_MAX_REQUESTS
 * applies. On the free tier Google may use prompts to improve its products: send only code you
 * may share.
 */
export class GeminiProvider implements CodeEditProvider {
  readonly name = "gemini";
  readonly model: string;
  /** A real private field: not enumerable, not serialised, not shown when the provider is inspected or logged. */
  readonly #apiKey: string;
  private readonly maxRequests: number | null;
  private readonly fetch: FetchLike;
  private readonly counter: RequestCounter;

  constructor(opts: { apiKey: string; model?: string; maxRequests?: number | null; fetch?: FetchLike; counter?: RequestCounter }) {
    this.model = opts.model || DEFAULT_GEMINI_MODEL;
    this.#apiKey = opts.apiKey;
    this.maxRequests = opts.maxRequests ?? null;
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.counter = opts.counter ?? meteredRequests;
  }

  generatePlan(context: PlanningContext): Promise<ProviderResult> {
    return this.request({ system: PLANNER_SYSTEM_PROMPT, user: buildUserMessage(context), schema: geminiSchema("plan"), maxTokens: 16000, what: "plan", timeoutMs: PLAN_TIMEOUT_MS });
  }

  generateEdits(context: EditContext): Promise<ProviderResult> {
    return this.request({ system: EDITOR_SYSTEM_PROMPT, user: buildEditUserMessage(context), schema: geminiSchema("change"), maxTokens: 32000, what: "change", timeoutMs: EDIT_TIMEOUT_MS });
  }

  private async request(r: { system: string; user: string; schema: Record<string, unknown>; maxTokens: number; what: "plan" | "change"; timeoutMs: number }): Promise<ProviderResult> {
    takeRequest(this.counter, this.maxRequests);
    const declined = r.what === "plan" ? "The model declined to plan this task." : "The model declined to make this change.";
    let res: Response;
    try {
      res = await this.fetch(`${GEMINI_BASE_URL}/models/${encodeURIComponent(this.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.#apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: r.system }] },
          contents: [{ role: "user", parts: [{ text: r.user }] }],
          generationConfig: { responseMimeType: "application/json", responseJsonSchema: r.schema, maxOutputTokens: r.maxTokens },
        }),
        signal: AbortSignal.timeout(r.timeoutMs),
      });
    } catch {
      throw new ProviderError("api-error", "The AI provider could not be reached.");
    }
    const raw = await res.text().catch(() => "");
    if (!res.ok) {
      const detail = this.errorDetail(res, raw);
      if (res.status === 429) throw new ProviderError("rate-limited", "The AI provider is rate limiting requests or the quota is used up; try again later.", detail);
      // An invalid key is a 400 with reason API_KEY_INVALID, not a 401.
      if (res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid/i.test(raw)) {
        throw new ProviderError("not-configured", "The AI provider rejected the request: check the API key and its permissions.", detail);
      }
      throw new ProviderError("api-error", `The AI provider returned an error (${res.status}).`, detail);
    }
    let body: GeminiResponse;
    try {
      body = JSON.parse(raw) as GeminiResponse;
    } catch {
      throw new ProviderError("api-error", "The AI provider returned an unreadable response.");
    }
    if (body.promptFeedback?.blockReason) throw new ProviderError("refused", declined);
    const candidate = body.candidates?.[0];
    const finish = candidate?.finishReason ?? null;
    if (finish && GEMINI_REFUSALS.has(finish)) throw new ProviderError("refused", declined);
    if (finish === "MAX_TOKENS") throw new ProviderError("truncated", `The ${r.what} exceeded the output limit and was cut off.`);
    const u = body.usageMetadata;
    // Thinking tokens are billed as output but reported separately from candidatesTokenCount.
    const usage = { inputTokens: u?.promptTokenCount ?? null, outputTokens: u?.candidatesTokenCount != null ? u.candidatesTokenCount + (u.thoughtsTokenCount ?? 0) : null };
    const text = (candidate?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new ProviderError("invalid-json", "The model did not return valid JSON.");
    }
    return { output, model: body.modelVersion || this.model, ...usage, stopReason: finish };
  }

  /** The loggable facts of an error response (`{ error: { code, message, status } }`), key removed. */
  private errorDetail(res: Response, raw: string): ProviderErrorDetail {
    let type: string | null = null;
    let message: string | null = null;
    try {
      const err = (JSON.parse(raw) as { error?: { message?: unknown; status?: unknown } }).error;
      if (typeof err?.message === "string") message = err.message;
      if (typeof err?.status === "string") type = err.status;
    } catch {
      message = raw || null;
    }
    return { status: res.status, type, requestId: null, message: redactedDetailMessage(message, this.#apiKey) };
  }
}

// ---------------------------------------------------------------- baseline (no LLM)

/**
 * A deterministic plan built only from the evidence bundle, with no LLM. Everything
 * it says about the repository is VERIFIED by construction or explicitly INFERRED;
 * it cannot interpret the task, so its confidence is low. Used when no AI provider is
 * configured (AI_PROVIDER=baseline) and as a reference in tests.
 */
export class BaselineProvider implements LLMProvider {
  readonly name = "baseline";
  readonly model = "deterministic";

  async generatePlan(context: PlanningContext): Promise<ProviderResult> {
    const ev = context.evidence;
    const files = ev.filter((e) => e.kind === "FILE" && e.path).slice(0, 6);
    const symbols = ev.filter((e) => e.kind === "SYMBOL" && e.path && e.symbol).slice(0, 8);
    const tests = ev.filter((e) => e.kind === "TEST" && e.path).slice(0, 6);
    const routes = ev.filter((e) => e.kind === "ROUTE");
    const findings = ev.filter((e) => e.kind === "FINDING").slice(0, 5);
    const conventions = ev.filter((e) => e.kind === "MANIFEST").map((e) => e.id);
    const output: PlanOutput = {
      taskSummary: context.task.request,
      interpretation:
        "Baseline plan built without an AI model: it lists the repository evidence that matches the task's keywords and its known dependants and tests. It does not interpret the task; review it as a starting point.",
      assumptions: [{ statement: "The files below are the ones whose names, symbols or routes match the task's keywords.", certainty: "INFERRED", evidence: files.map((f) => f.id) }],
      affectedFiles: files.map((f) => ({ path: f.path!, change: "review", reason: f.summary, certainty: "VERIFIED", evidence: [f.id] })),
      affectedSymbols: symbols.map((s) => ({ name: s.symbol!.split(".").pop()!, path: s.path!, change: "review", reason: s.summary, certainty: "VERIFIED", evidence: [s.id] })),
      architectureImpact: {
        statement: `${ev.filter((e) => e.kind === "IMPORT").length} import relationships connect the matching files to the rest of the repository; changes may reach their dependants.`,
        certainty: "INFERRED",
        evidence: ev.filter((e) => e.kind === "IMPORT").slice(0, 6).map((e) => e.id),
      },
      implementationSteps: files.slice(0, 3).map((f) => ({ title: `Review ${f.path}`, description: `Read ${f.path} and decide what the task requires there. ${f.summary}`, files: [f.path!], evidence: [f.id] })),
      testPlan: tests.map((t) => ({ description: `Re-run and extend ${t.path}. ${t.summary}`, path: t.path, kind: "existing", evidence: [t.id] })),
      configurationChanges: [],
      dependencyChanges: [],
      securityConsiderations: findings.map((f) => ({ statement: `Existing finding to take into account: ${f.summary}`, certainty: "VERIFIED", evidence: [f.id] })),
      performanceConsiderations: [],
      risks: routes.slice(0, 3).map((r) => ({ description: `Behaviour of ${r.symbol} may change.`, severity: "MEDIUM", mitigation: "Cover the route with a test before and after the change.", evidence: [r.id] })),
      validationPlan: ["Run the existing tests listed in the test plan and confirm they still pass.", "Add tests for the new behaviour and confirm they fail before and pass after the change."],
      unknowns: ["What the task requires in detail: the baseline planner does not interpret natural language.", ...(conventions.length ? [] : ["The repository's conventions (no manifest evidence)."])],
      confidence: files.length > 0 ? 0.3 : 0.1,
    };
    return { output, model: this.model, inputTokens: null, outputTokens: null, stopReason: "end_turn" };
  }
}

// ---------------------------------------------------------------- scripted (tests)

/** Returns the given outputs (or throws the given errors) in order, for plans and edits alike; for deterministic tests. */
export class ScriptedProvider implements CodeEditProvider {
  readonly name = "scripted";
  readonly model = "scripted";
  readonly calls: PlanningContext[] = [];
  readonly editCalls: EditContext[] = [];
  constructor(private readonly script: Array<unknown | Error>) {}

  async generatePlan(context: PlanningContext): Promise<ProviderResult> {
    this.calls.push(context);
    return this.next();
  }

  async generateEdits(context: EditContext): Promise<ProviderResult> {
    this.editCalls.push(context);
    return this.next();
  }

  private next(): ProviderResult {
    const next = this.script.length > 1 ? this.script.shift() : this.script[0];
    if (next instanceof Error) throw next;
    return { output: next, model: this.model, inputTokens: 100, outputTokens: 50, stopReason: "end_turn" };
  }
}

// ---------------------------------------------------------------- factory

export interface ProviderEnv {
  AI_PROVIDER?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  XAI_API_KEY?: string;
  XAI_MODEL?: string;
  XAI_BASE_URL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  /** Most requests this process may send to a metered provider (xAI, Gemini); unset means no limit. */
  AI_MAX_REQUESTS?: string;
}

/** The provider settings from a process environment (only these keys; credentials are never copied elsewhere). */
export function providerEnvFrom(env: Record<string, string | undefined>): ProviderEnv {
  const { AI_PROVIDER, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, XAI_API_KEY, XAI_MODEL, XAI_BASE_URL, GEMINI_API_KEY, GEMINI_MODEL, AI_MAX_REQUESTS } = env;
  return { AI_PROVIDER, ANTHROPIC_API_KEY, ANTHROPIC_MODEL, XAI_API_KEY, XAI_MODEL, XAI_BASE_URL, GEMINI_API_KEY, GEMINI_MODEL, AI_MAX_REQUESTS };
}

/** The configured provider. Throws ProviderError("not-configured") when the chosen provider cannot run. */
export function createProvider(env: ProviderEnv): LLMProvider {
  const name = (env.AI_PROVIDER || "anthropic").trim().toLowerCase();
  if (name === "baseline") return new BaselineProvider();
  if (name === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) throw new ProviderError("not-configured", "No AI provider is configured: set ANTHROPIC_API_KEY, or AI_PROVIDER=baseline for evidence-only plans.");
    return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL });
  }
  if (name === "xai") return createXaiProvider(env);
  if (name === "gemini") return createGeminiProvider(env);
  throw new ProviderError("not-configured", `Unsupported AI_PROVIDER "${name.slice(0, 40)}"; use "anthropic", "xai", "gemini" or "baseline".`);
}

function maxRequestsFrom(env: ProviderEnv): number | null {
  if (!env.AI_MAX_REQUESTS?.trim()) return null;
  const n = Number(env.AI_MAX_REQUESTS.trim());
  if (!Number.isInteger(n) || n < 0) throw new ProviderError("not-configured", "AI_MAX_REQUESTS must be a whole number (0 or more).");
  return n;
}

function createGeminiProvider(env: ProviderEnv): GeminiProvider {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new ProviderError("not-configured", "No AI provider is configured: AI_PROVIDER=gemini needs GEMINI_API_KEY.");
  // Accept the "models/…" form the API's model list uses.
  const model = env.GEMINI_MODEL?.trim().replace(/^models\//, "") || undefined;
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) throw new ProviderError("not-configured", "GEMINI_MODEL must be a model code such as gemini-3.8-flash.");
  return new GeminiProvider({ apiKey, model, maxRequests: maxRequestsFrom(env) });
}

function createXaiProvider(env: ProviderEnv): XaiProvider {
  const apiKey = env.XAI_API_KEY?.trim();
  if (!apiKey) throw new ProviderError("not-configured", "No AI provider is configured: AI_PROVIDER=xai needs XAI_API_KEY.");
  // No default model: every xAI request is billed, so the model is always an explicit choice.
  const model = env.XAI_MODEL?.trim();
  if (!model) throw new ProviderError("not-configured", "AI_PROVIDER=xai needs XAI_MODEL (for example grok-4.3).");
  let baseUrl: string | undefined;
  if (env.XAI_BASE_URL?.trim()) {
    const url = URL.parse(env.XAI_BASE_URL.trim());
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) throw new ProviderError("not-configured", "XAI_BASE_URL must be an http(s) URL.");
    baseUrl = url.href;
  }
  return new XaiProvider({ apiKey, model, baseUrl, maxRequests: maxRequestsFrom(env) });
}

/**
 * The configured provider for the code engine. Unlike planning, editing needs a
 * model: the deterministic baseline cannot write code, so it is refused here with a
 * clear message rather than failing during a run.
 */
export function createEditProvider(env: ProviderEnv): CodeEditProvider {
  const name = (env.AI_PROVIDER || "anthropic").trim().toLowerCase();
  if (name === "baseline") throw new ProviderError("not-configured", "The code engine needs an AI model: AI_PROVIDER=baseline can plan but cannot write code. Set AI_PROVIDER to anthropic (with ANTHROPIC_API_KEY), xai (with XAI_API_KEY and XAI_MODEL) or gemini (with GEMINI_API_KEY).");
  const provider = createProvider(env);
  if (!("generateEdits" in provider)) throw new ProviderError("not-configured", `AI_PROVIDER "${provider.name}" cannot write code.`);
  return provider as CodeEditProvider;
}
