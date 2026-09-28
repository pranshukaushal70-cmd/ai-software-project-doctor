import { z } from "zod";
import { FINDING_CATEGORIES, SEVERITIES } from "./constants";

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
});
export type FindingsQuery = z.infer<typeof findingsQuerySchema>;

/** Payload placed on the BullMQ analysis queue. */
export const analysisJobSchema = z.object({
  analysisId: idSchema,
});
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
