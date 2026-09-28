/** Languages with (or planned to have) a full analysis adapter. */
export const ANALYZED_LANGUAGES = ["javascript", "typescript", "python", "java", "c", "cpp"] as const;
export type AnalyzedLanguage = (typeof ANALYZED_LANGUAGES)[number];

const EXTENSIONS: Record<string, string> = {
  // analysed
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  py: "python", pyw: "python",
  java: "java",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", "c++": "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp", ipp: "cpp",
  // recognised only (counted, not deeply analysed yet)
  go: "go", rs: "rust", rb: "ruby", php: "php", cs: "csharp", kt: "kotlin", kts: "kotlin",
  swift: "swift", scala: "scala", dart: "dart", lua: "lua", r: "r", m: "objective-c",
  sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell",
  vue: "vue", svelte: "svelte",
  html: "html", htm: "html", css: "css", scss: "scss", sass: "scss", less: "less",
  sql: "sql", prisma: "prisma", graphql: "graphql", gql: "graphql", proto: "protobuf",
  md: "markdown", mdx: "markdown", rst: "restructuredtext",
  json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "toml", xml: "xml", ini: "ini",
  gradle: "gradle",
};

const FILENAMES: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  "CMakeLists.txt": "cmake",
  Jenkinsfile: "groovy",
};

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

export function detectLanguage(relPath: string): string | null {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  if (FILENAMES[base]) return FILENAMES[base]!;
  if (base.startsWith("Dockerfile")) return "dockerfile";
  return EXTENSIONS[extensionOf(base)] ?? null;
}

export function isAnalyzedLanguage(lang: string | null): lang is AnalyzedLanguage {
  return lang !== null && (ANALYZED_LANGUAGES as readonly string[]).includes(lang);
}

/** Languages that count as "programming" source for source/test classification. */
const PROGRAMMING = new Set<string>([
  ...ANALYZED_LANGUAGES,
  "go", "rust", "ruby", "php", "csharp", "kotlin", "swift", "scala", "dart", "lua", "r",
  "objective-c", "shell", "powershell", "vue", "svelte",
]);

export function isProgrammingLanguage(lang: string | null): boolean {
  return lang !== null && PROGRAMMING.has(lang);
}

export const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "avif", "tiff", "psd",
  "mp3", "mp4", "wav", "ogg", "webm", "mov", "avi", "flac",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war", "ear",
  "exe", "dll", "so", "dylib", "o", "a", "lib", "obj", "class", "pyc", "pyo", "wasm", "node",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "ttf", "otf", "woff", "woff2", "eot",
  "db", "sqlite", "sqlite3", "bin", "dat", "pkl", "h5", "onnx", "pt",
]);
