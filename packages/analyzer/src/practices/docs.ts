import { DEFAULT_IGNORED_DIRS } from "../ingest/ignore-rules";
import { snippet } from "../metrics/evidence";
import type { DocsInfo, EnvFileInfo } from "../scanner";
import { PRACTICE_THRESHOLDS } from "./rules";
import { dirname, lineIndex, type RawPracticeFinding, type TextFile } from "./types";

/**
 * Documentation analysis: whether the README explains how to install and use
 * the project, whether a license exists, whether the configuration the code
 * reads is documented, and whether documentation links point at real files.
 */

export const README_SECTIONS = ["installation", "usage", "configuration", "testing"] as const;
export type ReadmeSection = (typeof README_SECTIONS)[number];

export interface DocumentationSummary {
  readme: { path: string; words: number; headings: number; sections: Record<ReadmeSection, boolean> } | null;
  license: string | null;
  /** License declared in a manifest (package.json, pyproject.toml), even without a license file. */
  licenseDeclared: string | null;
  contributing: string | null;
  changelog: string | null;
  docsDir: boolean;
  markdownFiles: number;
  envVars: { used: number; documented: number; undocumented: string[]; templates: string[] };
  links: { checked: number; broken: number };
}

export interface DocumentationInput {
  /** Text of source, documentation and configuration files. */
  texts: readonly TextFile[];
  allPaths: readonly string[];
  docs: DocsInfo;
  envFiles: readonly EnvFileInfo[];
}

/** README content that shows a section, either as a heading or as the commands it would contain. */
const SECTION_SIGNS: Record<ReadmeSection, RegExp> = {
  installation: /^#{1,6}[^\n]*\b(?:install\w*|setup|set up|getting started|quick ?start|prerequisites|requirements)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci)\b|\bpip3?\s+install\b|\bpoetry\s+install\b|\bmvnw?\s+install\b|\bdocker[ -]compose\s+up\b|\bgo\s+(?:get|install)\b|\bcargo\s+(?:build|install)\b/im,
  usage: /^#{1,6}[^\n]*\b(?:usage|how to use|running|run|example\w*|getting started|quick ?start|commands|scripts|api)\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:start|dev|serve)\b|\bpython3?\s+[\w./-]+\.py\b|\bjava\s+-jar\b|\bdocker\s+run\b|\bgo\s+run\b|\bcargo\s+run\b/im,
  configuration: /^#{1,6}[^\n]*\b(?:config\w*|environment|env\w*|settings|options)\b|\.env\b/im,
  testing: /^#{1,6}[^\n]*\btest\w*\b|\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|\bpytest\b|\bmvnw?\s+test\b|\bgo\s+test\b|\bcargo\s+test\b/im,
};

const ENV_READS: Record<string, RegExp[]> = {
  js: [
    /\bprocess\.env\.([A-Z_][A-Z0-9_]*)\b/g,
    /\bprocess\.env\[\s*['"`]([A-Z_][A-Z0-9_]*)['"`]\s*\]/g,
    /\bimport\.meta\.env\.([A-Z_][A-Z0-9_]*)\b/g,
  ],
  python: [
    /\bos\.environ\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
    /\bos\.(?:environ\.get|getenv)\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
    /\benv(?:\.\w+)?\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  ],
  java: [/\bSystem\.getenv\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g],
  c: [/\bgetenv\(\s*"([A-Z_][A-Z0-9_]*)"\s*\)/g],
};
const ENV_DESTRUCTURE = /\{([^}]*)\}\s*=\s*process\.env\b/g;
/** Set by the runtime, the shell or CI rather than by the person deploying the application. */
const RUNTIME_ENV =
  /^(?:NODE_ENV|CI|HOME|PATH|PWD|USER|USERNAME|TZ|LANG|TERM|SHELL|TMPDIR|TEMP|TMP|HOSTNAME|NEXT_RUNTIME|NEXT_PHASE|JEST_WORKER_ID|PYTHONPATH|VIRTUAL_ENV|npm_\w+|VERCEL\w*|VITEST\w*|GITHUB_\w+|RUNNER_\w+|DEV|PROD|MODE|SSR|BASE_URL)$/;

const MD_LINK = /!?\[[^\]\n]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)\n]*["'])?\s*\)/g;
const FENCE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;

const langGroup = (language: string | null) =>
  language === "javascript" || language === "typescript" ? "js" : language === "c" || language === "cpp" ? "c" : language;
const wordCount = (text: string) => (text.replace(FENCE, " ").match(/[A-Za-z][\w'-]*/g) ?? []).length;

function normalize(path: string): string | null {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

function declaredLicense(texts: readonly TextFile[]): string | null {
  const pkg = texts.find((t) => t.path === "package.json");
  if (pkg) {
    try {
      const license = (JSON.parse(pkg.text) as { license?: unknown }).license;
      if (typeof license === "string" && license && license !== "UNLICENSED") return `package.json: ${license}`;
    } catch {
      // not JSON; ignored
    }
  }
  const py = texts.find((t) => t.path === "pyproject.toml");
  const m = py && /^\s*license\s*=\s*(?:\{[^}]*?(?:text|file)\s*=\s*)?["']([^"']+)["']/m.exec(py.text);
  return m ? `pyproject.toml: ${m[1]}` : null;
}

export function analyzeDocumentation(input: DocumentationInput): { raw: RawPracticeFinding[]; summary: DocumentationSummary } {
  const raw: RawPracticeFinding[] = [];
  const { docs } = input;
  const byPath = new Map(input.texts.map((t) => [t.path, t]));

  // README.
  let readme: DocumentationSummary["readme"] = null;
  if (!docs.readme) {
    raw.push({
      rule: "missingReadme",
      path: "",
      severity: "MEDIUM",
      line: null,
      evidence: "No README file was found in the repository root.",
      key: "readme",
    });
  } else {
    const text = byPath.get(docs.readme)?.text ?? "";
    const words = wordCount(text);
    // Commands inside code blocks count: `npm install` in a fenced block is an installation section.
    const sections = Object.fromEntries(README_SECTIONS.map((s) => [s, SECTION_SIGNS[s].test(text)])) as Record<ReadmeSection, boolean>;
    readme = { path: docs.readme, words, headings: (text.match(/^#{1,6}\s+\S/gm) ?? []).length, sections };
    const problems: string[] = [];
    if (words < PRACTICE_THRESHOLDS.readmeMinWords) problems.push(`it has only ${words} words (expected at least ${PRACTICE_THRESHOLDS.readmeMinWords})`);
    if (!sections.installation) problems.push("it does not explain how to install or set up the project");
    if (!sections.usage) problems.push("it does not explain how to run or use it");
    if (problems.length > 0) {
      raw.push({
        rule: "incompleteReadme",
        path: docs.readme,
        severity: "LOW",
        line: null,
        evidence: `\`${docs.readme}\`: ${problems.join("; ")}.`,
        key: "readme",
        data: { words, sections },
      });
    }
  }

  // License.
  const licenseDeclared = declaredLicense(input.texts);
  if (!docs.license) {
    raw.push({
      rule: "missingLicense",
      path: "",
      severity: "LOW",
      line: null,
      evidence: licenseDeclared
        ? `No LICENSE file in the repository root, although ${licenseDeclared} is declared; the license text itself is missing.`
        : "No LICENSE, LICENCE or COPYING file in the repository root.",
      key: "license",
      data: { declared: licenseDeclared },
    });
  }

  // Environment variables read by production code vs. documented ones.
  const used = new Map<string, { path: string; line: number }>();
  for (const f of input.texts) {
    if (f.kind !== "SOURCE") continue;
    const g = langGroup(f.language);
    const patterns = g ? ENV_READS[g] : undefined;
    if (!patterns) continue;
    const at = lineIndex(f.text);
    const note = (name: string, index: number) => {
      if (!RUNTIME_ENV.test(name) && !used.has(name)) used.set(name, { path: f.path, line: at(index) });
    };
    for (const re of patterns) for (const m of f.text.matchAll(re)) note(m[1]!, m.index);
    if (g === "js") {
      for (const m of f.text.matchAll(ENV_DESTRUCTURE)) {
        for (const part of m[1]!.split(",")) {
          const name = /^\s*([A-Z_][A-Z0-9_]*)\b/.exec(part)?.[1];
          if (name) note(name, m.index);
        }
      }
    }
  }
  const templates = input.envFiles.filter((e) => e.isTemplate).map((e) => e.path);
  const documentation = input.texts
    .filter((t) => t.kind === "DOCUMENTATION" || templates.includes(t.path) || (t.kind === "CONFIG" && !/^\.env(?:\.|$)/.test(t.path.split("/").pop()!)))
    .map((t) => t.text)
    .join("\n");
  const documented = new Set([...used.keys()].filter((name) => new RegExp(String.raw`\b${name}\b`).test(documentation)));
  const undocumented = [...used.keys()].filter((n) => !documented.has(n)).sort();
  if (undocumented.length > 0) {
    const first = [...used.entries()].find(([n]) => undocumented.includes(n))![1];
    const shown = undocumented.slice(0, 20).map((n) => `\`${n}\``).join(", ");
    raw.push({
      rule: "undocumentedEnvVars",
      path: first.path,
      severity: "LOW",
      line: first.line,
      evidence:
        `${undocumented.length} environment ${undocumented.length === 1 ? "variable is" : "variables are"} read by the code but appear in no .env template, documentation or configuration file: ${shown}` +
        (undocumented.length > 20 ? ` and ${undocumented.length - 20} more` : "") +
        (templates.length === 0 ? ". There is no committed .env.example." : "."),
      key: "env-vars",
      data: { names: undocumented.slice(0, 50), templates },
    });
  }

  // Relative links in Markdown documentation.
  const files = new Set(input.allPaths);
  const dirs = new Set(input.allPaths.flatMap((p) => p.split("/").slice(0, -1).map((_, i, segs) => segs.slice(0, i + 1).join("/"))));
  let checked = 0;
  let broken = 0;
  const markdown = input.texts.filter((t) => t.kind === "DOCUMENTATION" && /\.mdx?$/i.test(t.path)).slice(0, 200);
  for (const f of markdown) {
    const text = f.text.replace(FENCE, (m) => m.replace(/[^\n]/g, " "));
    const at = lineIndex(text);
    for (const m of text.matchAll(MD_LINK)) {
      const target = m[1]!;
      if (/^[a-z][a-z\d+.-]*:|^#|^\/\//i.test(target)) continue;
      let rel: string;
      try {
        rel = decodeURIComponent(target.replace(/[#?].*$/, ""));
      } catch {
        continue;
      }
      if (!rel) continue;
      const resolved = normalize(rel.startsWith("/") ? rel : `${dirname(f.path)}/${rel}`);
      if (resolved === null || DEFAULT_IGNORED_DIRS.has(resolved.split("/")[0]!)) continue;
      checked++;
      if (resolved === "" || files.has(resolved) || dirs.has(resolved.replace(/\/$/, ""))) continue;
      broken++;
      if (broken > PRACTICE_THRESHOLDS.maxBrokenLinks) continue;
      raw.push({
        rule: "brokenLink",
        path: f.path,
        severity: "LOW",
        line: at(m.index),
        evidence: `\`${snippet(m[0])}\` points to \`${resolved}\`, which does not exist in the repository.`,
        key: `link:${target}`,
        data: { target, resolved },
      });
    }
  }

  return {
    raw,
    summary: {
      readme,
      license: docs.license,
      licenseDeclared,
      contributing: docs.contributing,
      changelog: docs.changelog,
      docsDir: docs.docsDir,
      markdownFiles: input.allPaths.filter((p) => /\.mdx?$/i.test(p)).length,
      envVars: { used: used.size, documented: documented.size, undocumented: undocumented.slice(0, 50), templates },
      links: { checked, broken },
    },
  };
}
