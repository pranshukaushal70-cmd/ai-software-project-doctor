import { open, readFile, readdir, lstat } from "node:fs/promises";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import { isIgnoredDir } from "../ingest/ignore-rules";

export interface WalkedFile {
  /** Posix-style path relative to the repository root. */
  path: string;
  absPath: string;
  size: number;
}

export interface WalkResult {
  files: WalkedFile[];
  /** Directories skipped by default rules (node_modules, dist, …), relative paths. */
  ignoredDirs: string[];
  /** Files excluded by the repository's own .gitignore. */
  gitignoredFiles: number;
  symlinksSkipped: number;
  truncated: boolean;
}

export interface WalkOptions {
  maxFiles?: number;
}

async function loadGitignore(root: string): Promise<Ignore | null> {
  try {
    const text = await readFile(path.join(root, ".gitignore"), "utf8");
    return ignore().add(text);
  } catch {
    return null;
  }
}

/**
 * Walk a repository without following symlinks. Default-ignored directories
 * are pruned entirely; the repository's root .gitignore is honoured.
 */
export async function walkRepository(root: string, opts: WalkOptions = {}): Promise<WalkResult> {
  const maxFiles = opts.maxFiles ?? 50_000;
  const gitignore = await loadGitignore(root);
  const result: WalkResult = { files: [], ignoredDirs: [], gitignoredFiles: 0, symlinksSkipped: 0, truncated: false };

  const stack: string[] = [""];
  walk: while (stack.length > 0) {
    const relDir = stack.pop()!;
    const entries = await readdir(path.join(root, relDir), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        result.symlinksSkipped++;
        continue;
      }
      if (entry.isDirectory()) {
        if (isIgnoredDir(entry.name)) {
          result.ignoredDirs.push(rel);
          continue;
        }
        if (gitignore?.ignores(`${rel}/`)) {
          result.ignoredDirs.push(rel);
          continue;
        }
        stack.push(rel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (gitignore?.ignores(rel)) {
        result.gitignoredFiles++;
        continue;
      }
      if (result.files.length >= maxFiles) {
        result.truncated = true;
        break walk;
      }
      const absPath = path.join(root, relDir, entry.name);
      const stat = await lstat(absPath);
      result.files.push({ path: rel, absPath, size: stat.size });
    }
  }
  result.files.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

/** Heuristic binary sniff: a NUL byte in the first 8 KB. */
export async function looksBinary(absPath: string): Promise<boolean> {
  const handle = await open(absPath, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}
