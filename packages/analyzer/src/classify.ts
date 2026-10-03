import { classifyFile } from "./scanner/classify";
import { detectLanguage } from "./scanner/languages";
import type { FileKind } from "./scanner";

/**
 * Path-only classification, with no parser or filesystem dependency, for code that
 * must judge a path it has not scanned (e.g. a file the code engine proposes to
 * create). Text is assumed: binary content is rejected separately.
 */
export function kindOfPath(path: string): FileKind {
  return classifyFile(path, detectLanguage(path), false);
}

export { classifyFile, detectLanguage };
export { fileRole, type FileRole } from "./intelligence/roles";
