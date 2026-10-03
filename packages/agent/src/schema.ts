import { z } from "zod";

/**
 * Engineering plan schema. The model is asked to return exactly this shape (as a
 * JSON schema); its output is then parsed with this schema and validated against
 * the repository index (validate.ts). Lengths are bounded after parsing, not in the
 * schema, because structured-output JSON schemas do not support every constraint.
 */

/** VERIFIED: stated by a cited evidence item. INFERRED: reasoned from evidence. UNKNOWN: not determinable from the repository. */
export const CERTAINTY = ["VERIFIED", "INFERRED", "UNKNOWN"] as const;
export type Certainty = (typeof CERTAINTY)[number];

const certainty = z.enum(CERTAINTY);
/** Evidence ids from the context bundle (`E1`, `E2`, …). */
const evidence = z.array(z.string());

export const ClaimSchema = z.object({ statement: z.string(), certainty, evidence });

export const PlanOutputSchema = z.object({
  taskSummary: z.string(),
  interpretation: z.string(),
  assumptions: z.array(ClaimSchema),
  affectedFiles: z.array(
    z.object({
      path: z.string(),
      change: z.enum(["modify", "create", "delete", "review"]),
      reason: z.string(),
      certainty,
      evidence,
    }),
  ),
  affectedSymbols: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      change: z.enum(["modify", "create", "review"]),
      reason: z.string(),
      certainty,
      evidence,
    }),
  ),
  architectureImpact: ClaimSchema,
  implementationSteps: z.array(z.object({ title: z.string(), description: z.string(), files: z.array(z.string()), evidence })),
  testPlan: z.array(
    z.object({
      description: z.string(),
      /** Repository-relative path of an existing test, or of a proposed new test file; null when no file is implied. */
      path: z.string().nullable(),
      kind: z.enum(["existing", "new"]),
      evidence,
    }),
  ),
  configurationChanges: z.array(z.object({ path: z.string(), description: z.string(), certainty, evidence })),
  dependencyChanges: z.array(
    z.object({ package: z.string(), change: z.enum(["add", "remove", "upgrade", "none"]), reason: z.string(), certainty, evidence }),
  ),
  securityConsiderations: z.array(ClaimSchema),
  performanceConsiderations: z.array(ClaimSchema),
  risks: z.array(z.object({ description: z.string(), severity: z.enum(["LOW", "MEDIUM", "HIGH"]), mitigation: z.string(), evidence })),
  /** How to confirm the change works, described in words (never commands). */
  validationPlan: z.array(z.string()),
  /** What could not be established from the repository. */
  unknowns: z.array(z.string()),
  /** The model's own confidence, 0–1. */
  confidence: z.number(),
});
export type PlanOutput = z.infer<typeof PlanOutputSchema>;

// ---------------------------------------------------------------- evidence

export const EVIDENCE_KINDS = ["MANIFEST", "MODULE", "FILE", "SYMBOL", "ROUTE", "TEST", "CONFIG", "IMPORT", "PACKAGE", "FINDING"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** One fact from the deterministic repository index, numbered so plan claims can cite it. */
export interface Evidence {
  id: string;
  kind: EvidenceKind;
  path: string | null;
  symbol: string | null;
  line: number | null;
  /** What the index says, in one line. */
  summary: string;
  /** Which deterministic query produced it (search, impact, related-tests, …). */
  source: string;
}

export interface TaskInput {
  request: string;
  scope?: string | null;
  constraints?: string[];
}

/** Everything the planner may know about the repository for one task: bounded, structured, no file contents. */
export interface PlanningContext {
  task: { request: string; scope: string | null; constraints: string[] };
  repository: {
    name: string;
    primaryLanguage: string | null;
    languages: string[];
    frameworks: string[];
    testFrameworks: string[];
    packageManagers: string[];
    runtimes: string[];
  };
  evidence: Evidence[];
  stats: { searchHits: number; candidateFiles: number; evidence: number; truncated: boolean };
}
