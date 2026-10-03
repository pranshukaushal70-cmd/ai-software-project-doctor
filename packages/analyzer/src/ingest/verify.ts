import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { isInside } from "./workspace";

/** A file as the analysis recorded it: repository-relative path and SHA-256 of its bytes (null when not hashed). */
export interface ExpectedFile {
  path: string;
  contentHash: string | null;
}

export interface VerifyResult {
  /** Files whose bytes match the recorded hash. */
  verified: number;
  /** Files the analysis did not hash (binary or oversized); nothing to compare. */
  skipped: number;
  /** Files whose bytes differ, or that are no longer regular files (e.g. replaced by a symlink). */
  mismatched: string[];
  /** Files that no longer exist, and paths that are not valid repository-relative paths. */
  missing: string[];
}

const isRepoRelative = (p: string) =>
  p.length > 0 && !p.startsWith("/") && !/^[A-Za-z]:/.test(p) && !p.includes("\\") && !p.includes("\0") && !p.split("/").some((s) => s === ".." || s === "." || s === "");

/**
 * Checks that the files under `root` are the files the analysis indexed, by
 * comparing SHA-256 hashes with `File.contentHash`. The code engine only edits a
 * workspace that matches its analysis, so a plan built from the index applies to
 * the code it edits. Paths come from the database but are still checked: they must
 * be repository-relative, resolve inside `root` and name a regular file (symlinks
 * are not followed). Files are read one at a time.
 */
export async function verifyFiles(root: string, files: Iterable<ExpectedFile>): Promise<VerifyResult> {
  const result: VerifyResult = { verified: 0, skipped: 0, mismatched: [], missing: [] };
  for (const f of files) {
    if (!f.contentHash) {
      result.skipped++;
      continue;
    }
    const abs = path.resolve(root, ...f.path.split("/"));
    if (!isRepoRelative(f.path) || !isInside(root, abs)) {
      result.missing.push(f.path);
      continue;
    }
    const st = await lstat(abs).catch(() => null);
    if (!st) {
      result.missing.push(f.path);
      continue;
    }
    if (!st.isFile()) {
      result.mismatched.push(f.path);
      continue;
    }
    const hash = createHash("sha256").update(await readFile(abs)).digest("hex");
    if (hash === f.contentHash) result.verified++;
    else result.mismatched.push(f.path);
  }
  return result;
}
