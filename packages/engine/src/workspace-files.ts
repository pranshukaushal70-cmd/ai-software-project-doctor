import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isInside } from "@pd/analyzer";

/**
 * File access inside a run's workspace. Paths come from validated changes but are
 * checked again: repository-relative, resolving inside the root, and no existing
 * path component may be a symlink (the workspace should have none; this keeps a
 * write from ever leaving it).
 */

const MAX_READ_BYTES = 4 * 1024 * 1024;

function resolveInside(root: string, rel: string): string {
  if (!rel || rel.startsWith("/") || rel.includes("\\") || rel.includes("\0") || rel.split("/").some((s) => s === ".." || s === "." || s === "")) {
    throw new Error("invalid workspace path");
  }
  const abs = path.resolve(root, ...rel.split("/"));
  if (!isInside(root, abs) || abs === path.resolve(root)) throw new Error("workspace path escapes the root");
  return abs;
}

async function assertNoSymlinks(root: string, abs: string): Promise<void> {
  let current = path.resolve(root);
  for (const segment of path.relative(current, abs).split(path.sep)) {
    current = path.join(current, segment);
    const st = await lstat(current).catch(() => null);
    if (!st) return; // the rest does not exist yet
    if (st.isSymbolicLink()) throw new Error("workspace path crosses a symlink");
  }
}

/** The file's text, or null when it does not exist, is not a regular file or is too large to edit. */
export async function readWorkspaceFile(root: string, rel: string): Promise<string | null> {
  let abs: string;
  try {
    abs = resolveInside(root, rel);
    await assertNoSymlinks(root, abs);
  } catch {
    return null;
  }
  const st = await lstat(abs).catch(() => null);
  if (!st?.isFile() || st.size > MAX_READ_BYTES) return null;
  return readFile(abs, "utf8");
}

/** Writes (or, with null, deletes) a file inside the workspace. */
export async function writeWorkspaceFile(root: string, rel: string, content: string | null): Promise<void> {
  const abs = resolveInside(root, rel);
  await assertNoSymlinks(root, abs);
  if (content === null) {
    const st = await lstat(abs).catch(() => null);
    if (st?.isFile()) await rm(abs);
    return;
  }
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}
