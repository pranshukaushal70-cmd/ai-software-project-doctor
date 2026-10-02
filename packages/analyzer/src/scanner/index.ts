import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { classifyFile, type FileKind } from "./classify";
import {
  detectCi,
  detectContainers,
  detectDocs,
  detectEntryPoints,
  detectEnvFiles,
  detectFrameworks,
  detectPackageManagers,
  type Detection,
  type DocsInfo,
  type EnvFileInfo,
  type ManifestReader,
} from "./detectors";
import { detectLanguage, isAnalyzedLanguage } from "./languages";
import { buildTree, type TreeNode } from "./tree";
import { looksBinary, walkRepository } from "./walker";

export interface ScannedFile {
  path: string;
  absPath: string;
  size: number;
  language: string | null;
  kind: FileKind;
  /** Physical line count for text files within the size limit. */
  lines: number | null;
  /** True when the file exceeds maxFileBytes and its content is not analysed. */
  oversized: boolean;
  /** SHA-256 of the file bytes for files that were read (not binary, not oversized); null otherwise. */
  contentHash: string | null;
}

export interface LanguageStat {
  language: string;
  files: number;
  lines: number;
  bytes: number;
  analyzed: boolean;
}

export interface RepositoryScan {
  files: ScannedFile[];
  totals: {
    files: number;
    bytes: number;
    lines: number;
    byKind: Record<FileKind, number>;
  };
  languages: LanguageStat[];
  primaryLanguage: string | null;
  packageManagers: Detection[];
  buildSystems: Detection[];
  frameworks: Detection[];
  ci: Detection[];
  containers: Detection[];
  envFiles: EnvFileInfo[];
  entryPoints: Detection[];
  docs: DocsInfo;
  ignored: { dirs: string[]; gitignoredFiles: number; symlinksSkipped: number; truncated: boolean };
  tree: TreeNode;
}

export interface ScanOptions {
  maxFileBytes: number;
  maxFiles?: number;
}

const MANIFEST_READ_LIMIT = 512 * 1024;

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

/**
 * Deterministic repository inventory: what files exist, what they are, and
 * which ecosystems/tools the project uses. Never executes repository code.
 */
export async function scanRepository(root: string, opts: ScanOptions): Promise<RepositoryScan> {
  const walk = await walkRepository(root, { maxFiles: opts.maxFiles });
  const files: ScannedFile[] = [];

  for (const f of walk.files) {
    const language = detectLanguage(f.path);
    const oversized = f.size > opts.maxFileBytes;
    const binary = !oversized && f.size > 0 ? await looksBinary(f.absPath).catch(() => false) : false;
    const kind = classifyFile(f.path, language, binary);
    let lines: number | null = null;
    let contentHash: string | null = null;
    if (!oversized && kind !== "BINARY") {
      // A file that vanished or cannot be read keeps lines = null; the metrics stage reports it as a read error.
      const bytes = await readFile(f.absPath).catch(() => null);
      if (bytes) {
        lines = countLines(bytes.toString("utf8"));
        contentHash = createHash("sha256").update(bytes).digest("hex");
      }
    }
    files.push({ ...f, language: kind === "BINARY" ? null : language, kind, lines, oversized, contentHash });
  }

  const byKind: Record<FileKind, number> = { SOURCE: 0, TEST: 0, DOCUMENTATION: 0, CONFIG: 0, GENERATED: 0, BINARY: 0, OTHER: 0 };
  const langMap = new Map<string, LanguageStat>();
  let totalBytes = 0;
  let totalLines = 0;
  for (const f of files) {
    byKind[f.kind]++;
    totalBytes += f.size;
    totalLines += f.lines ?? 0;
    if (f.language && (f.kind === "SOURCE" || f.kind === "TEST")) {
      const stat = langMap.get(f.language) ?? { language: f.language, files: 0, lines: 0, bytes: 0, analyzed: isAnalyzedLanguage(f.language) };
      stat.files++;
      stat.lines += f.lines ?? 0;
      stat.bytes += f.size;
      langMap.set(f.language, stat);
    }
  }
  const languages = [...langMap.values()].sort((a, b) => b.lines - a.lines || b.files - a.files);

  const paths = files.map((f) => f.path);
  const pathSet = new Set(paths);
  const reader: ManifestReader = {
    paths,
    async read(rel) {
      if (!pathSet.has(rel)) return null;
      const file = files.find((f) => f.path === rel);
      if (!file || file.size > MANIFEST_READ_LIMIT) return null;
      try {
        return await readFile(path.join(root, rel), "utf8");
      } catch {
        return null;
      }
    },
  };

  const { packageManagers, buildSystems } = detectPackageManagers(paths);

  return {
    files,
    totals: { files: files.length, bytes: totalBytes, lines: totalLines, byKind },
    languages,
    primaryLanguage: languages[0]?.language ?? null,
    packageManagers,
    buildSystems,
    frameworks: await detectFrameworks(reader),
    ci: detectCi(paths),
    containers: detectContainers(paths),
    envFiles: detectEnvFiles(paths),
    entryPoints: await detectEntryPoints(reader),
    docs: detectDocs(paths),
    ignored: {
      dirs: walk.ignoredDirs,
      gitignoredFiles: walk.gitignoredFiles,
      symlinksSkipped: walk.symlinksSkipped,
      truncated: walk.truncated,
    },
    tree: buildTree(files),
  };
}

export type { FileKind, Detection, DocsInfo, EnvFileInfo, TreeNode };
