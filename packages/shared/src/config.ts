import os from "node:os";
import path from "node:path";
import { z } from "zod";

const int = (def: number) => z.coerce.number().int().positive().default(def);

const limitsSchema = z.object({
  WORKSPACE_DIR: z.string().optional(),
  MAX_UPLOAD_MB: int(50),
  MAX_EXTRACTED_MB: int(500),
  MAX_ZIP_ENTRIES: int(20_000),
  MAX_COMPRESSION_RATIO: int(100),
  MAX_FILE_KB: int(1024),
  CLONE_TIMEOUT_SECONDS: int(120),
  CLONE_DEPTH: int(500),
  OSV_ENABLED: z
    .enum(["true", "false", "1", "0"])
    .default("true")
    .transform((v) => v === "true" || v === "1"),
  OSV_TIMEOUT_SECONDS: int(90),
});

export interface AnalyzerLimits {
  workspaceDir: string;
  maxUploadBytes: number;
  maxExtractedBytes: number;
  maxZipEntries: number;
  maxCompressionRatio: number;
  maxFileBytes: number;
  cloneTimeoutMs: number;
  cloneDepth: number;
  /** Look up exact dependency versions on OSV.dev (package names and versions only; see docs/security.md). */
  osvEnabled: boolean;
  /** Overall time budget for the OSV.dev lookup of one analysis. */
  osvBudgetMs: number;
}

export function loadLimits(env: NodeJS.ProcessEnv = process.env): AnalyzerLimits {
  const parsed = limitsSchema.parse(
    Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== "")),
  );
  return {
    workspaceDir: parsed.WORKSPACE_DIR ? path.resolve(parsed.WORKSPACE_DIR) : path.join(os.tmpdir(), "project-doctor"),
    maxUploadBytes: parsed.MAX_UPLOAD_MB * 1024 * 1024,
    maxExtractedBytes: parsed.MAX_EXTRACTED_MB * 1024 * 1024,
    maxZipEntries: parsed.MAX_ZIP_ENTRIES,
    maxCompressionRatio: parsed.MAX_COMPRESSION_RATIO,
    maxFileBytes: parsed.MAX_FILE_KB * 1024,
    cloneTimeoutMs: parsed.CLONE_TIMEOUT_SECONDS * 1000,
    cloneDepth: parsed.CLONE_DEPTH,
    osvEnabled: parsed.OSV_ENABLED,
    osvBudgetMs: parsed.OSV_TIMEOUT_SECONDS * 1000,
  };
}
