/**
 * Repository path rules shared by plan validation (validate.ts) and the edit policy
 * (edit-policy.ts). Kept apart so validate.ts can use the edit policy without an
 * import cycle; validate.ts re-exports both.
 */

export const TEST_PATH = /(?:^|\/)(?:__tests__|tests?|spec|specs|e2e)\/|\.(?:test|spec|e2e)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$|Tests?\.java$/;
export const isRepoPath = (p: string) =>
  p.length > 0 && p.length <= 1000 && !p.startsWith("/") && !p.startsWith("~") && !/^[A-Za-z]:/.test(p) && !p.includes("\\") && !p.includes("\0") && !p.split("/").includes("..");
