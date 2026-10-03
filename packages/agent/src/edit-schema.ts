import { z } from "zod";

/**
 * Code engine (Phase 8): the shape of a proposed change. The model returns exact
 * search/replace edits rather than a diff, so every edit can be applied and checked
 * deterministically: `find` must occur exactly once in the current file. The output
 * is untrusted until edit-validate.ts has checked it against the approved plan's scope.
 */

export const EDIT_OPERATIONS = ["modify", "create", "delete"] as const;
export type EditOperation = (typeof EDIT_OPERATIONS)[number];

export const EditOutputSchema = z.object({
  /** What the change does, in a few sentences. */
  summary: z.string(),
  changes: z.array(
    z.object({
      path: z.string(),
      operation: z.enum(EDIT_OPERATIONS),
      reason: z.string(),
      /** modify: replacements applied in order, each `find` matching exactly once. Empty otherwise. */
      edits: z.array(z.object({ find: z.string(), replace: z.string() })),
      /** create: the complete new file. Null otherwise. */
      content: z.string().nullable(),
    }),
  ),
  /** What the model could not do or is unsure about. */
  notes: z.array(z.string()),
  /** The model's own confidence, 0–1. */
  confidence: z.number(),
});
export type EditOutput = z.infer<typeof EditOutputSchema>;

/** Files the model may change, derived from the approved plan (edit-context.ts). */
export interface EditScope {
  /** Existing files the plan approves modifying (and existing tests it names). */
  modify: string[];
  /** New files the plan approves creating. */
  create: string[];
  /** Existing files the plan approves deleting. */
  delete: string[];
  /** Whether new test files not named in the plan may be added (test-path conventions only). */
  newTests: boolean;
  /** Whether the plan approves dependency changes (package manifests may then be modified, if in scope). */
  dependencyChanges: boolean;
}

/** One file shown to the model: redacted, LF line endings, never a secret file. */
export interface ContextFile {
  path: string;
  /** What the file is for in this change. */
  purpose: "modify" | "delete" | "test" | "reference";
  content: string;
  /** Credential-like values were replaced with `<redacted>` before the model saw the file. */
  redacted: boolean;
}

/** Feedback for a repair iteration: what went wrong with the previous attempt. */
export interface RepairFeedback {
  /** 1-based iteration being repaired. */
  iteration: number;
  /** The previous attempt's unified diff (already redacted). */
  previousDiff: string;
  /** Why the previous attempt is being repaired: validation problems and/or failing test output (redacted, truncated). */
  problems: string[];
  testOutput: string | null;
}

/** Everything the model may know for one edit request: bounded, redacted, no secret files. */
export interface EditContext {
  task: { request: string; constraints: string[] };
  plan: {
    summary: string;
    interpretation: string;
    steps: Array<{ title: string; description: string; files: string[] }>;
    tests: Array<{ description: string; path: string | null; kind: "existing" | "new" }>;
    dependencyChanges: Array<{ package: string; change: string; reason: string }>;
    configurationChanges: Array<{ path: string; description: string }>;
  };
  scope: EditScope;
  files: ContextFile[];
  /** Files in scope that could not be shown (too large, binary, unreadable, secret, over the limits). */
  omitted: Array<{ path: string; reason: string }>;
  repair: RepairFeedback | null;
  stats: { files: number; bytes: number; truncated: boolean };
}
