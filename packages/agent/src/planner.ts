import { ProviderError, type LLMProvider, type ProviderErrorDetail } from "./providers";
import type { PlanningContext } from "./schema";
import { validatePlan, type RepositoryFacts, type ValidatedPlan, type ValidationReport } from "./validate";

export interface PlanRunMetadata {
  provider: string;
  /** The model that served the request (the requested one unless a fallback ran). */
  model: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
}

export type PlanRunResult =
  | { ok: true; plan: ValidatedPlan; report: ValidationReport; meta: PlanRunMetadata }
  /** No usable plan: the provider failed (`detail`: what its API said, for the log only), or its output was rejected by validation. */
  | { ok: false; reason: string; message: string; report: ValidationReport | null; meta: PlanRunMetadata; detail?: ProviderErrorDetail | null };

/** Context in, validated plan out. The provider sees only the context; the plan is checked against the index. */
export async function runPlanner(context: PlanningContext, provider: LLMProvider, facts: RepositoryFacts, now: () => number = () => performance.now()): Promise<PlanRunResult> {
  const started = now();
  const meta = (extra: Partial<PlanRunMetadata> = {}): PlanRunMetadata => ({
    provider: provider.name,
    model: provider.model,
    durationMs: Math.round(now() - started),
    inputTokens: null,
    outputTokens: null,
    stopReason: null,
    ...extra,
  });
  let result;
  try {
    result = await provider.generatePlan(context);
  } catch (err) {
    const reason = err instanceof ProviderError ? err.reason : "api-error";
    const message = err instanceof ProviderError ? err.message : "The AI provider failed unexpectedly.";
    const detail = err instanceof ProviderError ? err.detail : null;
    return { ok: false, reason, message, report: null, meta: meta(), detail };
  }
  const m = meta({ model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, stopReason: result.stopReason });
  const { plan, report } = validatePlan(result.output, context, facts);
  if (!plan) return { ok: false, reason: "invalid-output", message: "The model's output did not match the plan schema and was rejected.", report, meta: m };
  return { ok: true, plan, report, meta: m };
}
