export { ANALYZER_VERSION } from "./version";
export { extractZipSafely, sanitizeEntryName, type ZipLimits, type ZipExtractResult } from "./ingest/zip";
export { cloneRepository, fetchCommit, runGit, type CloneResult, type FetchCommitOptions } from "./ingest/clone";
export { verifyFiles, type ExpectedFile, type VerifyResult } from "./ingest/verify";
export { createWorkspace, uploadPath, uploadsDir, isInside, type Workspace } from "./ingest/workspace";
export { DEFAULT_IGNORED_DIRS } from "./ingest/ignore-rules";
export { scanRepository, type RepositoryScan, type ScannedFile, type LanguageStat, type FileKind, type TreeNode } from "./scanner";
export { buildTree } from "./scanner/tree";
