import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser, type Tree } from "web-tree-sitter";
import type { GrammarId } from "./languages";

const require = createRequire(import.meta.url);

/** npm package and file name of each grammar's prebuilt WebAssembly build. */
const GRAMMAR_FILES: Record<GrammarId, [pkg: string, file: string]> = {
  javascript: ["tree-sitter-javascript", "tree-sitter-javascript.wasm"],
  typescript: ["tree-sitter-typescript", "tree-sitter-typescript.wasm"],
  tsx: ["tree-sitter-typescript", "tree-sitter-tsx.wasm"],
  python: ["tree-sitter-python", "tree-sitter-python.wasm"],
  java: ["tree-sitter-java", "tree-sitter-java.wasm"],
  c: ["tree-sitter-c", "tree-sitter-c.wasm"],
  cpp: ["tree-sitter-cpp", "tree-sitter-cpp.wasm"],
};

let init: Promise<void> | null = null;
const languages = new Map<GrammarId, Promise<Language>>();
const parsers = new Map<GrammarId, Parser>();

function packageDir(pkg: string): string {
  return path.dirname(require.resolve(`${pkg}/package.json`));
}

async function loadLanguage(id: GrammarId): Promise<Language> {
  init ??= Parser.init();
  await init;
  let lang = languages.get(id);
  if (!lang) {
    const [pkg, file] = GRAMMAR_FILES[id];
    lang = Language.load(path.join(packageDir(pkg), file));
    languages.set(id, lang);
  }
  return lang;
}

/**
 * Parse source with the grammar for `id`. Parsing runs inside WebAssembly, so
 * untrusted input cannot reach native code. Returns null when parsing exceeds
 * `timeoutMs` (pathological input); the caller skips the file.
 * The caller must call `tree.delete()` to release WebAssembly memory.
 */
export async function parseSource(id: GrammarId, source: string, timeoutMs: number): Promise<Tree | null> {
  const language = await loadLanguage(id);
  let parser = parsers.get(id);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(id, parser);
  }
  const deadline = performance.now() + timeoutMs;
  const tree = parser.parse(source, null, {
    // Returning true cancels the parse (the .d.ts types the return as void).
    progressCallback: (() => performance.now() > deadline) as () => void,
  });
  if (!tree) parser.reset();
  return tree;
}

/** Versions of the parser runtime and grammars, recorded with results for reproducibility. */
export function parserVersions(): Record<string, string> {
  const versionOf = (pkg: string): string => {
    // Some packages (web-tree-sitter) do not export package.json, so walk up from the entry point.
    let dir = path.dirname(require.resolve(pkg));
    for (;;) {
      try {
        const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; version: string };
        if (manifest.name === pkg) return manifest.version;
      } catch {
        // keep walking
      }
      const parent = path.dirname(dir);
      if (parent === dir) return "unknown";
      dir = parent;
    }
  };
  const out: Record<string, string> = { "web-tree-sitter": versionOf("web-tree-sitter") };
  for (const [pkg] of Object.values(GRAMMAR_FILES)) out[pkg] = versionOf(pkg);
  return out;
}
