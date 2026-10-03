import { access, cp, rename } from "node:fs/promises";
import path from "node:path";
import { extractZipSafely, fetchCommit, uploadPath, type ZipExtractResult } from "@pd/analyzer";
import type { RepositorySource } from "@pd/db";
import { AppError, type AnalyzerLimits } from "@pd/shared";

/**
 * Re-creates the source an analysis was made from, for the code engine (Phase 8).
 * Analyses keep no source code, so a run first rebuilds it in a fresh workspace:
 * the analysed commit for git sources, the retained upload for ZIP sources, the
 * bundled project for the demo. The caller verifies the result against the
 * analysis's content hashes (verifyFiles) and disposes of the workspace.
 * The helpers below are shared with the analysis pipeline, so both ingest the
 * same way.
 */

export const DEFAULT_DEMO_DIR = path.resolve(import.meta.dirname, "../../../demo/storefront");
/**
 * The demo stores its manifests under these names so that dependency scanners (GitHub's
 * dependency graph, Dependabot) do not report its deliberately outdated packages against
 * this repository. They get their real names back in the analysis workspace.
 */
const DEMO_RENAMES: ReadonlyArray<[string, string]> = [
  ["package.json.demo", "package.json"],
  ["package-lock.json.demo", "package-lock.json"],
];

/** Copies the bundled demo project to `dest`, so nothing done to the copy can touch the original. */
export async function copyDemoProject(demoDir: string, dest: string): Promise<void> {
  await cp(demoDir, dest, { recursive: true, verbatimSymlinks: true }).catch(() => {
    throw new AppError("ANALYSIS_FAILED", "The demo project is not available on this server");
  });
  for (const [from, to] of DEMO_RENAMES) await rename(path.join(dest, from), path.join(dest, to)).catch(() => undefined);
}

/** Extracts an uploaded archive with the ingest safety limits. */
export function extractUpload(limits: AnalyzerLimits, uploadKey: string, dest: string): Promise<ZipExtractResult> {
  return extractZipSafely(uploadPath(limits.workspaceDir, uploadKey), dest, {
    maxEntries: limits.maxZipEntries,
    maxExtractedBytes: limits.maxExtractedBytes,
    maxCompressionRatio: limits.maxCompressionRatio,
    maxFileBytes: limits.maxFileBytes,
  });
}

export interface MaterializeSource {
  source: RepositorySource;
  url: string | null;
  uploadKey: string | null;
  /** The commit the analysis recorded (git sources). */
  commitSha: string | null;
}

export interface Materialized {
  /** Repository root: the paths of the analysis's File rows are relative to it. */
  root: string;
  commitSha: string | null;
}

export interface MaterializeDeps {
  limits: AnalyzerLimits;
  demoDir?: string;
  /** Test hook; defaults to the hardened fetchCommit. */
  fetchCommit?: typeof fetchCommit;
}

/** Rebuilds the analysed source inside `workspaceDir` (a fresh, per-run workspace). */
export async function materializeRepository(src: MaterializeSource, workspaceDir: string, deps: MaterializeDeps): Promise<Materialized> {
  const { limits } = deps;
  switch (src.source) {
    case "GITHUB":
    case "GITLAB": {
      if (!src.url) throw new AppError("VALIDATION_ERROR", "Repository has no URL");
      if (!src.commitSha) throw new AppError("CONFLICT", "This analysis did not record its commit; run a new analysis");
      const fetched = await (deps.fetchCommit ?? fetchCommit)({
        url: src.url,
        commitSha: src.commitSha,
        destDir: workspaceDir,
        timeoutMs: limits.cloneTimeoutMs,
        // The same disk budget an uploaded archive gets once extracted.
        maxBytes: limits.maxExtractedBytes,
      });
      return { root: fetched.dir, commitSha: fetched.commitSha };
    }
    case "ZIP": {
      // Archives of completed analyses are kept until the analysis is deleted (see uploads.ts);
      // analyses made before Phase 8 had theirs deleted after analysis.
      const stored = src.uploadKey ? await access(uploadPath(limits.workspaceDir, src.uploadKey)).then(() => true, () => false) : false;
      if (!stored) throw new AppError("CONFLICT", "The uploaded archive of this analysis is no longer stored; upload the project again");
      const extracted = await extractUpload(limits, src.uploadKey!, path.join(workspaceDir, "src"));
      return { root: extracted.root, commitSha: null };
    }
    case "DEMO": {
      const root = path.join(workspaceDir, "src");
      await copyDemoProject(deps.demoDir ?? DEFAULT_DEMO_DIR, root);
      return { root, commitSha: null };
    }
    default:
      throw new AppError("VALIDATION_ERROR", "Unsupported repository source");
  }
}
