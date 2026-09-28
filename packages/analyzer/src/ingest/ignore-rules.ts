/**
 * Directories skipped during extraction and scanning. They are almost always
 * vendored, generated or tool state and would distort every metric.
 */
export const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  "venv",
  ".venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
  "bower_components",
  "vendor",
  "__MACOSX",
  "Pods",
  ".terraform",
]);

export function isIgnoredDir(name: string): boolean {
  return DEFAULT_IGNORED_DIRS.has(name);
}

/** True if any directory segment of a posix relative path is ignored. */
export function hasIgnoredSegment(relPath: string): boolean {
  const parts = relPath.split("/");
  parts.pop();
  return parts.some(isIgnoredDir);
}
