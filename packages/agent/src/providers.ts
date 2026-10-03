import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { buildEditUserMessage, EDITOR_SYSTEM_PROMPT } from "./edit-prompt";
import { EditOutputSchema, type EditContext } from "./edit-schema";
import { buildUserMessage, PLANNER_SYSTEM_PROMPT } from "./prompt";
import { PlanOutputSchema, type PlanOutput, type PlanningContext } from "./schema";

/**
 * LLM provider abstraction. A provider turns a planning context into raw plan
 * output; it never touches the repository and its output is treated as untrusted
 * (validated by validate.ts). Providers are replaceable: Anthropic is the default,
 * "baseline" plans without any LLM, and tests use a scripted provider.
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

/** A provider failure whose message is safe to store and show (no prompt, no key). */
export class ProviderError extends Error {
  constructor(
    readonly reason: "not-configured" | "refused" | "truncated" | "invalid-json" | "api-error" | "rate-limited",
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// ---------------------------------------------------------------- Anthropic

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";
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
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 2, timeout: 5 * 60 * 1000 });
  }

  generatePlan(context: PlanningContext): Promise<ProviderResult> {
    return this.request({ system: PLANNER_SYSTEM_PROMPT, user: buildUserMessage(context), schema: PLAN_FORMAT.schema, maxTokens: 16000, what: "plan" });
  }

  generateEdits(context: EditContext): Promise<ProviderResult> {
    // Edits carry whole new files and replacement blocks: a larger output budget than plans.
    return this.request({ system: EDITOR_SYSTEM_PROMPT, user: buildEditUserMessage(context), schema: EDIT_FORMAT.schema, maxTokens: 32000, what: "change" });
  }

  /** One structured-output request; failures become ProviderErrors with user-safe messages. */
  private async request(r: { system: string; user: string; schema: Record<string, unknown>; maxTokens: number; what: "plan" | "change" }): Promise<ProviderResult> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = (await this.client.beta.messages.create({
        model: this.model,
        max_tokens: r.maxTokens,
        // A safety-classifier decline is retried server-side on Anthropic's recommended fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "high", format: { type: "json_schema", schema: r.schema } },
        system: [{ type: "text", text: r.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: r.user }],
      })) as Anthropic.Beta.BetaMessage;
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError) throw new ProviderError("rate-limited", "The AI provider is rate limiting requests; try again later.");
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new ProviderError("not-configured", "The AI provider rejected the configured credentials.");
      }
      if (err instanceof Anthropic.APIError) throw new ProviderError("api-error", `The AI provider returned an error (${err.status ?? "network"}).`);
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
}

/** The configured provider. Throws ProviderError("not-configured") when the chosen provider cannot run. */
export function createProvider(env: ProviderEnv): LLMProvider {
  const name = (env.AI_PROVIDER || "anthropic").trim().toLowerCase();
  if (name === "baseline") return new BaselineProvider();
  if (name === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) throw new ProviderError("not-configured", "No AI provider is configured: set ANTHROPIC_API_KEY, or AI_PROVIDER=baseline for evidence-only plans.");
    return new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL });
  }
  throw new ProviderError("not-configured", `Unsupported AI_PROVIDER "${name.slice(0, 40)}"; use "anthropic" or "baseline".`);
}

/**
 * The configured provider for the code engine. Unlike planning, editing needs a
 * model: the deterministic baseline cannot write code, so it is refused here with a
 * clear message rather than failing during a run.
 */
export function createEditProvider(env: ProviderEnv): CodeEditProvider {
  const name = (env.AI_PROVIDER || "anthropic").trim().toLowerCase();
  if (name === "baseline") throw new ProviderError("not-configured", "The code engine needs an AI model: AI_PROVIDER=baseline can plan but cannot write code. Set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY.");
  const provider = createProvider(env);
  if (!("generateEdits" in provider)) throw new ProviderError("not-configured", `AI_PROVIDER "${provider.name}" cannot write code.`);
  return provider as CodeEditProvider;
}
