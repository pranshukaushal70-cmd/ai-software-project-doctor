import { readToml, tomlInlineTable, tomlString, tomlStringArray } from "./toml";
import type { DependencyRecord, DependencySource, ParsedManifest } from "./types";

/** PEP 503 normalised project name. */
export const normalizePyName = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

const PEP508 = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*(.*)$/;

/** Exact version from a PEP 440 specifier (`==1.2.3`, `===1.2.3`), or null for ranges and wildcards. */
export function exactPyVersion(spec: string): string | null {
  const m = /^\s*={2,3}\s*([0-9][0-9A-Za-z.+!-]*)\s*$/.exec(spec);
  return m && !m[1]!.includes("*") ? m[1]! : null;
}

const DEV_GROUP = /^(dev|develop|development|test|tests|testing|lint|linting|docs|doc|typing|types|mypy|ci|bench|benchmark)$/i;

interface PyRequirement {
  name: string;
  spec: string;
  source: DependencySource;
}

/** Parse one PEP 508 requirement string (`requests[socks]>=2.0; python_version<"3.12"`). */
export function parseRequirement(text: string): PyRequirement | null {
  const req = text.replace(/;.*$/, "").trim();
  if (!req) return null;
  const direct = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*@\s*(\S+)/.exec(req);
  if (direct) {
    return { name: normalizePyName(direct[1]!), spec: direct[3]!, source: /^git\+/.test(direct[3]!) ? "git" : /^file:/.test(direct[3]!) ? "path" : "url" };
  }
  const m = PEP508.exec(req);
  if (!m) return null;
  const spec = m[3]!.replace(/^\(|\)$/g, "").replace(/\s+/g, "");
  return { name: normalizePyName(m[1]!), spec, source: "registry" };
}

const record = (
  path: string,
  req: PyRequirement,
  dev: boolean,
  line: number,
  resolved: string | null = req.source === "registry" ? exactPyVersion(req.spec) : null,
): DependencyRecord => ({
  ecosystem: "PyPI",
  name: req.name,
  versionSpec: req.spec || null,
  resolvedVersion: resolved,
  direct: true,
  dev,
  manifestPath: path,
  line,
  source: req.source,
  publicRegistry: true,
});

/** requirements*.txt / constraints files. Files named for dev/test use are treated as development dependencies. */
export function parseRequirementsTxt(path: string, text: string): ParsedManifest {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dev = /(^|[-_.])(dev|test|tests|testing|lint|docs|ci)([-_.]|$)/i.test(base.replace(/\.txt$/, ""));
  const deps: DependencyRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // A requirement continued with `\` is reported at the line where it starts.
    const start = i + 1;
    let line = lines[i]!.replace(/(^|\s)#.*$/, "").trim();
    while (line.endsWith("\\") && i + 1 < lines.length) line = `${line.slice(0, -1)} ${lines[++i]!.trim()}`;
    line = line.replace(/\s--hash=\S+/g, "").trim();
    if (!line) continue;
    if (/^-e\s+|^--editable\s+/.test(line) || /^(git\+|https?:\/\/)/.test(line)) {
      const url = line.replace(/^(-e|--editable)\s+/, "");
      const egg = /[#&]egg=([A-Za-z0-9._-]+)/.exec(url);
      if (egg) deps.push(record(path, { name: normalizePyName(egg[1]!), spec: url, source: /^git\+/.test(url) ? "git" : /^(\.|\/|file:)/.test(url) ? "path" : "url" }, dev, start));
      continue;
    }
    if (line.startsWith("-")) continue; // -r, -c, --index-url, …
    const req = parseRequirement(line);
    if (req) deps.push(record(path, req, dev, start));
  }
  return { path, ecosystem: "PyPI", kind: "manifest", dependencies: deps };
}

/** Poetry version constraint (`^1.2`, `1.2.3`, `*`) → PEP 440-ish spec; exact when it is a bare version. */
function poetrySpec(raw: string): { spec: string; exact: string | null } {
  const s = raw.trim();
  if (/^\d[0-9A-Za-z.+!-]*$/.test(s)) return { spec: `==${s}`, exact: s };
  return { spec: s, exact: exactPyVersion(s) };
}

/** pyproject.toml (PEP 621, PEP 735 dependency groups, Poetry) and Pipfile. */
export function parsePyprojectOrPipfile(path: string, text: string): ParsedManifest {
  const deps: DependencyRecord[] = [];
  const pipfile = /(^|\/)Pipfile$/.test(path);
  let table = "";
  for (const ev of readToml(text)) {
    if (ev.type === "table") {
      table = ev.name;
      continue;
    }
    const { key, value, line } = ev;
    // PEP 621 / PEP 735: arrays of requirement strings.
    const arrayDev =
      table === "project" && key === "dependencies"
        ? false
        : table === "project.optional-dependencies"
          ? DEV_GROUP.test(key)
          : table === "dependency-groups"
            ? true
            : table === "tool.uv" && key === "dev-dependencies"
              ? true
              : null;
    if (arrayDev !== null) {
      for (const item of tomlStringArray(value)) {
        const req = parseRequirement(item);
        if (req) deps.push(record(path, req, arrayDev, line));
      }
      continue;
    }
    // Poetry / Pipfile: `name = "spec"` or `name = { version = "spec", git = … }`.
    const poetryGroup = /^tool\.poetry\.(dependencies|dev-dependencies|group\.([^.]+)\.dependencies)$/.exec(table);
    const pipfileSection = pipfile && (table === "packages" || table === "dev-packages");
    if (!poetryGroup && !pipfileSection) continue;
    if (key.toLowerCase() === "python") continue;
    const dev = pipfileSection ? table === "dev-packages" : poetryGroup![1] === "dev-dependencies" || (!!poetryGroup![2] && DEV_GROUP.test(poetryGroup![2]));
    const str = tomlString(value);
    const inline = tomlInlineTable(value);
    const rawSpec = str ?? inline.version ?? "";
    const source: DependencySource = inline.git ? "git" : inline.path || inline.file ? "path" : inline.url ? "url" : "registry";
    if (pipfile) {
      const spec = rawSpec === "*" ? "*" : rawSpec;
      deps.push(record(path, { name: normalizePyName(key), spec, source }, dev, line));
    } else {
      const { spec, exact } = poetrySpec(rawSpec || "*");
      deps.push(record(path, { name: normalizePyName(key), spec, source }, dev, line, source === "registry" ? exact : null));
    }
  }
  return { path, ecosystem: "PyPI", kind: "manifest", dependencies: deps };
}

/** poetry.lock / uv.lock / pdm.lock: `[[package]]` tables with name and version. */
export function parsePythonLock(text: string): Array<{ name: string; version: string; line: number; dev: boolean; registry: boolean }> {
  const out: Array<{ name: string; version: string; line: number; dev: boolean; registry: boolean }> = [];
  let cur: { name?: string; version?: string; line: number; dev: boolean; registry: boolean } | null = null;
  const flush = () => {
    if (cur?.name && cur.version && cur.registry) out.push({ name: normalizePyName(cur.name), version: cur.version, line: cur.line, dev: cur.dev, registry: true });
  };
  for (const ev of readToml(text)) {
    if (ev.type === "table") {
      if (ev.array && ev.name === "package") {
        flush();
        cur = { line: ev.line, dev: false, registry: true };
      } else if (!ev.name.startsWith("package.")) {
        flush();
        cur = null;
      }
      continue;
    }
    if (!cur) continue;
    if (ev.key === "name") cur.name = tomlString(ev.value) ?? undefined;
    else if (ev.key === "version") cur.version = tomlString(ev.value) ?? undefined;
    else if (ev.key === "category") cur.dev = tomlString(ev.value) === "dev";
    // uv: source = { registry = "…" } | { git = … } | { editable = "." } | { virtual = "." }
    else if (ev.key === "source") {
      const src = tomlInlineTable(ev.value);
      if (src.git || src.editable || src.virtual || src.path || src.directory || src.url) cur.registry = false;
      // poetry: [package.source] type = "git"/"directory"/"file"/"url"
    } else if (ev.key === "source.type" || ev.key === "type") {
      if (/^(git|directory|file|url)$/.test(tomlString(ev.value) ?? "")) cur.registry = false;
    }
  }
  flush();
  return out;
}

/** Pipfile.lock: JSON with `default` and `develop` sections of `{ version: "==x" }`. */
export function parsePipfileLock(text: string): Array<{ name: string; version: string; dev: boolean; line: number | null }> {
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch {
    return [];
  }
  if (!lock || typeof lock !== "object") return [];
  const lines = text.split(/\r?\n/);
  const out: Array<{ name: string; version: string; dev: boolean; line: number | null }> = [];
  for (const [section, dev] of [
    ["default", false],
    ["develop", true],
  ] as const) {
    const table = (lock as Record<string, unknown>)[section];
    if (!table || typeof table !== "object") continue;
    const sectionLine = lines.findIndex((l) => new RegExp(`^\\s*"${section}"\\s*:`).test(l));
    for (const [name, entry] of Object.entries(table as Record<string, unknown>)) {
      const version = entry && typeof entry === "object" ? (entry as Record<string, unknown>).version : undefined;
      const exact = typeof version === "string" ? exactPyVersion(version) : null;
      if (!exact) continue;
      const idx = lines.findIndex((l, i) => i > sectionLine && l.trimStart().startsWith(`"${name}"`));
      out.push({ name: normalizePyName(name), version: exact, dev, line: idx >= 0 ? idx + 1 : null });
    }
  }
  return out;
}
