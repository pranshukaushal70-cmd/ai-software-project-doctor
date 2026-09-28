import { BINARY_EXTENSIONS, extensionOf, isProgrammingLanguage } from "./languages";

export type FileKind = "SOURCE" | "TEST" | "DOCUMENTATION" | "CONFIG" | "GENERATED" | "BINARY" | "OTHER";

const TEST_PATH_PATTERNS: RegExp[] = [
  /(^|\/)(__tests__|__mocks__|tests?|spec|specs|e2e|cypress|playwright)\//i,
  /(^|\/)src\/test\//, // Maven/Gradle
  /\.(test|spec|e2e|cy)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.(py|go|c|cc|cpp)$/,
  /(^|\/)[^/]+Tests?\.java$/,
  /(^|\/)conftest\.py$/,
];

const GENERATED_PATTERNS: RegExp[] = [
  /\.min\.(js|css)$/i,
  /\.map$/i,
  /\.d\.ts$/i,
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|composer\.lock|Cargo\.lock|gradle\.lockfile)$/,
  /\.(pb|pb2)\.(go|py)$/,
  /_pb2(_grpc)?\.py$/,
  /\.generated\.[a-z]+$/i,
  /(^|\/)generated\//i,
  /(^|\/)migrations\/\d+[^/]*\.(py|sql)$/,
];

const DOC_FILENAMES = /^(readme|changelog|changes|contributing|code_of_conduct|security|authors|license|licence|copying|notice)(\.[a-z]+)?$/i;
const DOC_EXTENSIONS = new Set(["md", "mdx", "rst", "adoc", "txt"]);

const CONFIG_FILENAMES = new Set([
  "package.json", "tsconfig.json", "jsconfig.json", "requirements.txt", "pyproject.toml", "setup.py", "setup.cfg",
  "Pipfile", "pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts",
  "CMakeLists.txt", "Makefile", "Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml",
  "compose.yaml", "Jenkinsfile", ".gitlab-ci.yml", "azure-pipelines.yml", "vercel.json", "netlify.toml",
  "Procfile", "tox.ini", "pytest.ini", "babel.config.js", "vite.config.ts", "vite.config.js",
  "next.config.js", "next.config.mjs", "next.config.ts", "webpack.config.js", "jest.config.js", "jest.config.ts",
  "vitest.config.ts", "vitest.config.js", "tailwind.config.js", "tailwind.config.ts", "postcss.config.js",
  "postcss.config.mjs", "eslint.config.js", "eslint.config.mjs", "prettier.config.js", "nodemon.json",
]);
const CONFIG_EXTENSIONS = new Set(["json", "jsonc", "yml", "yaml", "toml", "ini", "cfg", "conf", "xml", "properties", "env", "gradle"]);

export function isTestPath(relPath: string): boolean {
  return TEST_PATH_PATTERNS.some((re) => re.test(relPath));
}

/** Classify by path alone; `isBinary` comes from a content sniff when available. */
export function classifyFile(relPath: string, language: string | null, isBinary: boolean): FileKind {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const ext = extensionOf(base);

  if (isBinary || BINARY_EXTENSIONS.has(ext)) return "BINARY";
  if (GENERATED_PATTERNS.some((re) => re.test(relPath))) return "GENERATED";
  if (isProgrammingLanguage(language)) return isTestPath(relPath) ? "TEST" : "SOURCE";
  if (DOC_FILENAMES.test(base)) return "DOCUMENTATION";
  if (DOC_EXTENSIONS.has(ext) && ext !== "txt") return "DOCUMENTATION";
  if (ext === "txt" && /(^|\/)docs?\//i.test(relPath)) return "DOCUMENTATION";
  if (CONFIG_FILENAMES.has(base) || base.startsWith(".env") || base.startsWith("Dockerfile")) return "CONFIG";
  if (base.startsWith(".")) return "CONFIG"; // dotfiles: .gitignore, .eslintrc, …
  if (CONFIG_EXTENSIONS.has(ext)) return "CONFIG";
  if (/(^|\/)\.github\//.test(relPath)) return "CONFIG";
  return "OTHER";
}
