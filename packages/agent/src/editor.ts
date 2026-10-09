import type { EditContext } from "./edit-schema";
import { buildReport, validateEdits, type EditIssue, type EditReport, type ProposedChange } from "./edit-validate";
import type { PlanRunMetadata } from "./planner";
import { ProviderError, type CodeEditProvider, type ProviderErrorDetail } from "./providers";
import type { RepositoryFacts } from "./validate";

export type EditRunResult =
  | { ok: true; summary: string; notes: string[]; changes: ProposedChange[]; report: EditReport; meta: PlanRunMetadata }
  /** No usable output: the provider failed (`detail`: what its API said, for the log only), or its output was rejected by schema validation. */
  | { ok: false; reason: string; message: string; report: EditReport | null; meta: PlanRunMetadata; detail?: ProviderErrorDetail | null };

export interface RunEditorOptions {
  /** Checks of the applied result (checkChanges from `@pd/agent/checks` in the worker); may reject changes. */
  check?: (changes: ProposedChange[]) => Promise<EditIssue[]>;
  now?: () => number;
}

/**
 * Context in, validated changes out. The provider sees only the context (redacted
 * contents of in-scope files); edits are applied to the originals in memory and
 * checked. `ok: true` can still have zero accepted changes: the report says why,
 * and the caller decides whether to repair or stop. Never touches the filesystem.
 */
export async function runEditor(
  context: EditContext,
  originals: ReadonlyMap<string, string>,
  provider: CodeEditProvider,
  facts: RepositoryFacts,
  opts: RunEditorOptions = {},
): Promise<EditRunResult> {
  const now = opts.now ?? (() => performance.now());
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
    result = await provider.generateEdits(context);
  } catch (err) {
    const reason = err instanceof ProviderError ? err.reason : "api-error";
    const message = err instanceof ProviderError ? err.message : "The AI provider failed unexpectedly.";
    const detail = err instanceof ProviderError ? err.detail : null;
    return { ok: false, reason, message, report: null, meta: meta(), detail };
  }
  const m = () => meta({ model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, stopReason: result.stopReason });
  const validated = validateEdits(result.output, context, originals, facts);
  if (validated.report.status === "REJECTED") {
    return { ok: false, reason: "invalid-output", message: "The model's output did not match the edit schema and was rejected.", report: validated.report, meta: m() };
  }
  let report = validated.report;
  if (opts.check) {
    const extra = await opts.check(validated.changes);
    if (extra.length) report = buildReport([...report.issues, ...extra], validated.changes, report.modelConfidence);
  }
  return { ok: true, summary: validated.summary, notes: validated.notes, changes: validated.changes, report, meta: m() };
}
