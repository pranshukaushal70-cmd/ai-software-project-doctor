import { z } from "zod";
import { DEPENDENCY_ECOSYSTEMS, FINDING_CATEGORIES, SEVERITIES, SYMBOL_KINDS } from "./constants";

export const emailSchema = z.email().max(254).transform((v) => v.toLowerCase());

export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(200, "Password is too long");

export const signupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  password: passwordSchema,
});
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const analysisModeSchema = z.enum(["LOCAL_ONLY", "AI"]);
export type AnalysisMode = z.infer<typeof analysisModeSchema>;

export const createAnalysisFromUrlSchema = z.object({
  url: z.string().trim().min(1).max(500),
  mode: analysisModeSchema.default("LOCAL_ONLY"),
});

export const idSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

const commaList = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .max(500)
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(item).max(20));

/** GET /api/analysis/:id/findings query. List filters are comma-separated (`severity=HIGH,MEDIUM`). */
export const findingsQuerySchema = paginationSchema.extend({
  severity: commaList(z.enum(SEVERITIES)).optional(),
  category: commaList(z.enum(FINDING_CATEGORIES)).optional(),
  type: commaList(z.string().regex(/^[a-z0-9-]{1,64}$/)).optional(),
  path: z.string().trim().min(1).max(1000).optional(),
  /** `untriaged` hides findings marked Expected or Ignored; `triaged` shows only those. Default: everything. */
  triage: z.enum(["all", "untriaged", "triaged"]).default("all"),
});
export type FindingsQuery = z.infer<typeof findingsQuerySchema>;

export const TRIAGE_STATUSES = ["EXPECTED", "IGNORED"] as const;
export type TriageStatus = (typeof TRIAGE_STATUSES)[number];

/** PUT /api/analysis/:id/findings/:findingId/triage body. */
export const triageInputSchema = z.object({
  status: z.enum(TRIAGE_STATUSES),
  reason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v ? v : undefined)),
});
export type TriageInput = z.infer<typeof triageInputSchema>;

/** `true` / `false` query flag; absent means "no filter". */
const queryFlag = z.enum(["true", "false"]).transform((v) => v === "true");

/** GET /api/analysis/:id/dependencies query. */
export const dependenciesQuerySchema = paginationSchema.extend({
  ecosystem: commaList(z.enum(DEPENDENCY_ECOSYSTEMS)).optional(),
  /** Declared in a manifest (`direct`) or only present in a lockfile (`transitive`). */
  scope: z.enum(["all", "direct", "transitive"]).default("all"),
  dev: z.enum(["include", "exclude", "only"]).default("include"),
  vulnerable: queryFlag.optional(),
  unused: queryFlag.optional(),
  /** Case-insensitive substring of the package name. */
  q: z.string().trim().min(1).max(200).optional(),
  manifest: z.string().trim().min(1).max(1000).optional(),
  sort: z.enum(["name", "ecosystem", "manifest"]).default("name"),
});
export type DependenciesQuery = z.infer<typeof dependenciesQuerySchema>;

/** GET /api/analysis/:id/architecture query. */
export const architectureQuerySchema = z.object({
  /** `modules`: directory-level graph; `files`: file-level import graph. */
  view: z.enum(["modules", "files"]).default("modules"),
  /** Files view: only files of this module (directory key). */
  module: z.string().trim().min(1).max(1000).optional(),
  /** Only nodes that are part of an import cycle. */
  cycles: queryFlag.optional(),
  /** Most connected nodes first; the rest is reported as truncated. */
  limit: z.coerce.number().int().min(1).max(2000).default(300),
});
export type ArchitectureQuery = z.infer<typeof architectureQuerySchema>;

/** Payload placed on the BullMQ analysis queue. */
export const analysisJobSchema = z.object({
  analysisId: idSchema,
});
export type AnalysisJob = z.infer<typeof analysisJobSchema>;

// ---------------------------------------------------------------- repository intelligence (Phase 6)

/**
 * A repository-relative posix path as stored on File rows. Paths are only matched
 * against stored rows, never used on the filesystem; rejecting absolute paths,
 * backslashes, NUL and `..` segments keeps it that way by construction.
 */
export const repoPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.includes("\0") && !p.split("/").includes(".."), "Must be a path relative to the repository root");

const symbolName = z.string().trim().min(1).max(200);

/** GET /api/analysis/:id/symbols query. `q` matches names case-insensitively (substring). */
export const symbolsQuerySchema = paginationSchema.extend({
  q: z.string().trim().min(1).max(200).optional(),
  kind: commaList(z.enum(SYMBOL_KINDS)).optional(),
  path: repoPathSchema.optional(),
  exported: queryFlag.optional(),
});
export type SymbolsQuery = z.infer<typeof symbolsQuerySchema>;

/** GET /api/analysis/:id/references query: call sites of a symbol (by id) or of a name. */
export const referencesQuerySchema = paginationSchema
  .extend({ symbolId: idSchema.optional(), name: symbolName.optional() })
  .refine((q) => !!q.symbolId !== !!q.name, "Give either symbolId or name");
export type ReferencesQuery = z.infer<typeof referencesQuerySchema>;

/** GET /api/analysis/:id/imports query. */
export const importsQuerySchema = z.object({
  path: repoPathSchema,
  /** `imports`: what the file imports (including packages); `importers`: files importing it. */
  direction: z.enum(["imports", "importers"]).default("imports"),
});
export type ImportsQuery = z.infer<typeof importsQuerySchema>;

const impactType = z.enum(["file", "symbol", "module"]);

/** GET /api/analysis/:id/impact query. For a symbol, `path` narrows it to the definition in that file. */
export const impactQuerySchema = z.object({
  type: impactType,
  target: z.string().trim().min(1).max(1000),
  path: repoPathSchema.optional(),
  depth: z.coerce.number().int().min(1).max(20).default(10),
});
export type ImpactQuery = z.infer<typeof impactQuerySchema>;

/**
 * POST /api/analysis/:id/context: the structured interface for AI agents. Each operation
 * returns structured, bounded context (no file contents) computed deterministically.
 */
export const contextRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("manifest") }),
  z.object({ operation: z.literal("search"), query: z.string().trim().min(1).max(300), limit: z.number().int().min(1).max(100).default(25) }),
  z.object({ operation: z.literal("find_symbol"), name: symbolName, path: repoPathSchema.optional() }),
  z.object({ operation: z.literal("find_references"), name: symbolName, path: repoPathSchema.optional() }),
  z.object({ operation: z.literal("file_imports"), path: repoPathSchema }),
  z.object({ operation: z.literal("file_importers"), path: repoPathSchema }),
  z.object({ operation: z.literal("related_tests"), path: repoPathSchema }),
  z.object({ operation: z.literal("find_route"), query: z.string().trim().min(1).max(300) }),
  z.object({
    operation: z.literal("impact_analysis"),
    target: z.string().trim().min(1).max(1000),
    /** Inferred when omitted: a stored file path, else a module directory, else a symbol name. */
    type: impactType.optional(),
    path: repoPathSchema.optional(),
    depth: z.number().int().min(1).max(20).default(10),
  }),
]);
export type ContextRequest = z.infer<typeof contextRequestSchema>;

// ---------------------------------------------------------------- engineering planner

export const ENGINEERING_TASK_LIMITS = { minRequest: 10, maxRequest: 2000, maxConstraints: 10, maxConstraint: 300 } as const;

/** Visible text only: control characters (other than newlines and tabs) are rejected. */
const plainText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s), "Must not contain control characters");

export const engineeringTaskSchema = z
  .object({
    analysisId: idSchema,
    task: plainText(ENGINEERING_TASK_LIMITS.minRequest, ENGINEERING_TASK_LIMITS.maxRequest),
    /** Repository-relative directory to limit the plan to. */
    scope: repoPathSchema.optional(),
    constraints: z.array(plainText(1, ENGINEERING_TASK_LIMITS.maxConstraint)).max(ENGINEERING_TASK_LIMITS.maxConstraints).default([]),
  })
  .strict();
export type EngineeringTaskInput = z.infer<typeof engineeringTaskSchema>;
