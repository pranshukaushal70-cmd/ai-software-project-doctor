import path from "node:path";

/**
 * Resolves import specifiers recorded by the code-metrics pass to files inside
 * the repository. Resolution is static and conservative: an import is only
 * linked to a file when the language's lookup rules point at exactly that file.
 */
export type Resolution =
  /** One file, or every class of a package for Java wildcard imports. */
  | { kind: "internal"; targets: string[] }
  /** A third-party package or module outside the repository. */
  | { kind: "external"; name: string }
  /** Standard library / platform module. */
  | { kind: "builtin" }
  /** Looks repository-local (relative path, quoted include) but matches no file. */
  | { kind: "unresolved" };

export interface ResolverInput {
  /** Every file path in the repository (posix, relative). */
  paths: readonly string[];
  /** Read a small text file (tsconfig/jsconfig/package.json); null when missing. */
  read(relPath: string): Promise<string | null>;
}

const posix = path.posix;
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const baseOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** Normalise a repository-relative path; null when it escapes the repository root. */
function normal(p: string): string | null {
  const n = posix.normalize(p).replace(/^\.\/|\/$/g, "");
  if (n === "." || n === "") return "";
  return n.startsWith("../") || n === ".." || n.startsWith("/") ? null : n;
}

/** Strip comments and trailing commas from JSONC (tsconfig.json), respecting strings. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function parseJsonc(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(stripJsonc(text.replace(/^﻿/, "")));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const NODE_BUILTINS = new Set(
  "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder sys test timers tls trace_events tty url util v8 vm wasi worker_threads zlib".split(
    " ",
  ),
);

const PYTHON_STDLIB = new Set(
  "__future__ abc argparse array ast asyncio base64 binascii bisect builtins bz2 calendar cmath collections concurrent configparser contextlib contextvars copy csv ctypes dataclasses datetime decimal difflib dis email enum errno fnmatch fractions functools gc getpass gettext glob gzip hashlib heapq hmac html http importlib inspect io ipaddress itertools json keyword locale logging lzma math mimetypes multiprocessing numbers operator os pathlib pickle platform pprint queue random re sched secrets select selectors shelve shlex shutil signal site smtplib socket socketserver sqlite3 ssl stat statistics string struct subprocess sys sysconfig tarfile tempfile textwrap threading time timeit tkinter token tokenize traceback types typing unicodedata unittest urllib uuid venv warnings weakref xml xmlrpc zipfile zlib zoneinfo".split(
    " ",
  ),
);

const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
/** TypeScript ESM code imports `./x.js` for a `./x.ts` source file. */
const TS_SWAP: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

interface TsConfig {
  dir: string;
  baseUrl: string | null;
  paths: Array<{ pattern: string; targets: string[] }>;
}

interface WorkspacePackage {
  name: string;
  dir: string;
  exports: unknown;
  main: string | null;
}

export interface Resolver {
  resolve(from: string, language: string, spec: string): Resolution;
  /** Counts for the summary, to explain how imports were linked. */
  info: { tsconfigs: number; pathAliases: number; workspacePackages: number; pythonRoots: string[] };
}

/** First string target of a package.json `exports` condition tree (import → default → require → types). */
function exportTarget(value: unknown, depth = 0): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const t = exportTarget(v, depth + 1);
      if (t) return t;
    }
    return null;
  }
  if (!value || typeof value !== "object" || depth > 5) return null;
  const rec = value as Record<string, unknown>;
  for (const key of ["source", "import", "module", "default", "require", "node", "types"]) {
    if (key in rec) {
      const t = exportTarget(rec[key], depth + 1);
      if (t) return t;
    }
  }
  return null;
}

export async function createResolver(input: ResolverInput): Promise<Resolver> {
  const files = new Set(input.paths);
  const exists = (p: string | null): p is string => p !== null && files.has(p);

  // ------------------------------------------------------------ tsconfig / jsconfig
  const tsconfigs = new Map<string, TsConfig>();
  const loadTsconfig = async (file: string, seen: Set<string>): Promise<{ baseUrl: string | null; paths: TsConfig["paths"] } | null> => {
    if (seen.has(file) || seen.size > 5) return null;
    seen.add(file);
    const json = parseJsonc(await input.read(file));
    if (!json) return null;
    const dir = dirOf(file);
    let inherited: { baseUrl: string | null; paths: TsConfig["paths"] } | null = null;
    const ext = typeof json.extends === "string" ? json.extends : Array.isArray(json.extends) ? json.extends.find((e) => typeof e === "string") : null;
    if (typeof ext === "string" && ext.startsWith(".")) {
      const target = normal(posix.join(dir, ext.endsWith(".json") ? ext : `${ext}.json`));
      if (target !== null) inherited = await loadTsconfig(target, seen);
    }
    const co = (json.compilerOptions ?? {}) as Record<string, unknown>;
    const baseUrl = typeof co.baseUrl === "string" ? normal(posix.join(dir, co.baseUrl)) : inherited?.baseUrl ?? null;
    let paths = inherited?.paths ?? [];
    if (co.paths && typeof co.paths === "object") {
      // `paths` are relative to baseUrl when set, otherwise to the tsconfig that declares them.
      const root = typeof co.baseUrl === "string" ? baseUrl : dir;
      paths = Object.entries(co.paths as Record<string, unknown>)
        .filter((e): e is [string, string[]] => Array.isArray(e[1]))
        .map(([pattern, targets]) => ({
          pattern,
          targets: targets.filter((t): t is string => typeof t === "string").map((t) => posix.join(root ?? "", t)),
        }));
    }
    return { baseUrl, paths };
  };
  for (const p of input.paths) {
    const base = baseOf(p);
    if (base !== "tsconfig.json" && base !== "jsconfig.json") continue;
    const dir = dirOf(p);
    if (tsconfigs.has(dir) && base === "jsconfig.json") continue;
    const cfg = await loadTsconfig(p, new Set());
    if (cfg) tsconfigs.set(dir, { dir, ...cfg });
  }
  const tsconfigFor = (file: string): TsConfig | null => {
    let d = dirOf(file);
    for (;;) {
      const c = tsconfigs.get(d);
      if (c) return c;
      if (!d) return null;
      d = dirOf(d);
    }
  };

  // ------------------------------------------------------------ workspace packages
  const packages: WorkspacePackage[] = [];
  for (const p of input.paths) {
    if (baseOf(p) !== "package.json") continue;
    const json = parseJsonc(await input.read(p));
    if (!json || typeof json.name !== "string") continue;
    packages.push({ name: json.name, dir: dirOf(p), exports: json.exports, main: typeof json.main === "string" ? json.main : typeof json.module === "string" ? json.module : null });
  }
  packages.sort((a, b) => b.name.length - a.name.length);

  // ------------------------------------------------------------ JS / TS
  const jsCandidate = (base: string | null): string | null => {
    if (base === null) return null;
    if (exists(base) && JS_EXTENSIONS.some((e) => base.endsWith(e))) return base;
    const ext = posix.extname(base);
    for (const swap of TS_SWAP[ext] ?? []) {
      const p = base.slice(0, -ext.length) + swap;
      if (exists(p)) return p;
    }
    for (const e of JS_EXTENSIONS) if (exists(base + e)) return base + e;
    for (const e of JS_EXTENSIONS) if (exists(`${base ? `${base}/` : ""}index${e}`)) return `${base ? `${base}/` : ""}index${e}`;
    // Non-code assets (JSON, CSS) exist but are not graph nodes.
    return exists(base) ? base : null;
  };

  const resolveWorkspace = (spec: string): string | null | undefined => {
    const pkg = packages.find((p) => spec === p.name || spec.startsWith(`${p.name}/`));
    if (!pkg) return undefined;
    const sub = spec === pkg.name ? "." : `./${spec.slice(pkg.name.length + 1)}`;
    let target: string | null = null;
    if (pkg.exports !== undefined && pkg.exports !== null) {
      const exp = pkg.exports;
      const isMap = typeof exp === "object" && !Array.isArray(exp) && Object.keys(exp as object).some((k) => k.startsWith("."));
      if (isMap) {
        const map = exp as Record<string, unknown>;
        target = exportTarget(map[sub]);
        if (!target) {
          for (const [key, value] of Object.entries(map)) {
            const star = key.indexOf("*");
            if (star < 0) continue;
            const [pre, post] = [key.slice(0, star), key.slice(star + 1)];
            if (sub.startsWith(pre) && sub.endsWith(post) && sub.length >= pre.length + post.length) {
              const t = exportTarget(value);
              if (t) target = t.replace("*", sub.slice(pre.length, sub.length - post.length));
              break;
            }
          }
        }
      } else if (sub === ".") target = exportTarget(exp);
    }
    if (!target) target = sub === "." ? (pkg.main ?? "index") : sub;
    return jsCandidate(normal(posix.join(pkg.dir, target)));
  };

  const matchPaths = (cfg: TsConfig, spec: string): string | null | undefined => {
    let matched = false;
    for (const { pattern, targets } of cfg.paths) {
      const star = pattern.indexOf("*");
      let capture: string | null = null;
      if (star < 0) capture = pattern === spec ? "" : null;
      else {
        const pre = pattern.slice(0, star);
        const post = pattern.slice(star + 1);
        if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) capture = spec.slice(pre.length, spec.length - post.length);
      }
      if (capture === null) continue;
      matched = true;
      for (const t of targets) {
        const hit = jsCandidate(normal(t.replace("*", capture)));
        if (hit) return hit;
      }
    }
    return matched ? null : undefined;
  };

  const resolveJs = (from: string, rawSpec: string): Resolution => {
    const spec = rawSpec.replace(/[?#].*$/, "");
    if (!spec) return { kind: "unresolved" };
    if (spec.startsWith("node:") || NODE_BUILTINS.has(spec.split("/")[0]!)) return { kind: "builtin" };
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return { kind: "external", name: spec.split(":")[0]! };
    if (spec.startsWith(".")) {
      const hit = jsCandidate(normal(posix.join(dirOf(from), spec)));
      return hit ? { kind: "internal", targets: [hit] } : { kind: "unresolved" };
    }
    if (spec.startsWith("/")) return { kind: "unresolved" };
    const cfg = tsconfigFor(from);
    if (cfg) {
      const viaPaths = matchPaths(cfg, spec);
      if (viaPaths) return { kind: "internal", targets: [viaPaths] };
      if (viaPaths === null) return { kind: "unresolved" };
      if (cfg.baseUrl !== null) {
        const hit = jsCandidate(normal(posix.join(cfg.baseUrl, spec)));
        if (hit) return { kind: "internal", targets: [hit] };
      }
    }
    const ws = resolveWorkspace(spec);
    if (ws) return { kind: "internal", targets: [ws] };
    const parts = spec.split("/");
    return { kind: "external", name: spec.startsWith("@") && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0]! };
  };

  // ------------------------------------------------------------ Python
  const pyFiles = input.paths.filter((p) => p.endsWith(".py"));
  const pyRoots = new Set<string>(["", "src"]);
  for (const p of pyFiles) {
    // The parent of the outermost package directory (a chain of __init__.py) is an import root.
    let d = dirOf(p);
    if (!files.has(`${d ? `${d}/` : ""}__init__.py`)) continue;
    while (d && files.has(`${dirOf(d) ? `${dirOf(d)}/` : ""}__init__.py`)) d = dirOf(d);
    pyRoots.add(dirOf(d));
  }
  const pyCandidate = (base: string | null): string | null => {
    if (base === null) return null;
    const init = `${base ? `${base}/` : ""}__init__.py`;
    if (base && exists(`${base}.py`)) return `${base}.py`;
    if (exists(init)) return init;
    if (base && exists(`${base}.pyi`)) return `${base}.pyi`;
    return null;
  };
  const resolvePython = (from: string, spec: string): Resolution => {
    const rel = /^(\.+)(.*)$/.exec(spec);
    if (rel) {
      let dir: string | null = dirOf(from);
      for (let i = 1; i < rel[1]!.length && dir !== null; i++) dir = dir ? dirOf(dir) : null;
      if (dir === null) return { kind: "unresolved" };
      const rest = rel[2]!.replace(/\./g, "/");
      const hit = pyCandidate(normal(rest ? posix.join(dir, rest) : dir));
      return hit ? { kind: "internal", targets: [hit] } : { kind: "unresolved" };
    }
    const top = spec.split(".")[0]!;
    const modulePath = spec.replace(/\./g, "/");
    // Try the longest module path first, then parents (`import pkg.mod.Class`-style specs are rare but valid for from-imports).
    for (const root of [...pyRoots].sort((a, b) => b.length - a.length)) {
      let mp = modulePath;
      for (;;) {
        const hit = pyCandidate(normal(root ? `${root}/${mp}` : mp));
        if (hit) return { kind: "internal", targets: [hit] };
        if (!mp.includes("/")) break;
        mp = dirOf(mp);
      }
    }
    return PYTHON_STDLIB.has(top) ? { kind: "builtin" } : { kind: "external", name: top };
  };

  // ------------------------------------------------------------ Java
  const javaByName = new Map<string, string[]>();
  const javaByDir = new Map<string, string[]>();
  for (const p of input.paths) {
    if (!p.endsWith(".java")) continue;
    const cls = baseOf(p).slice(0, -5);
    javaByName.set(cls, [...(javaByName.get(cls) ?? []), p]);
    javaByDir.set(dirOf(p), [...(javaByDir.get(dirOf(p)) ?? []), p]);
  }
  const resolveJava = (spec: string): Resolution => {
    const parts = spec.split(".");
    if (/^(java|javax|jdk|sun|com\.sun)\./.test(spec)) return { kind: "builtin" };
    if (parts.at(-1) === "*") {
      const suffix = parts.slice(0, -1).join("/");
      const targets = [...javaByDir.entries()].filter(([d]) => d === suffix || d.endsWith(`/${suffix}`)).flatMap(([, ps]) => ps);
      if (targets.length > 0) return { kind: "internal", targets: targets.sort() };
    }
    // Class, nested class or static member import: strip trailing segments until a file matches.
    for (let n = parts.length; n >= 2; n--) {
      const cls = parts[n - 1]!;
      const suffix = `${parts.slice(0, n).join("/")}.java`;
      const hit = (javaByName.get(cls) ?? []).filter((p) => p === suffix || p.endsWith(`/${suffix}`));
      if (hit.length === 1) return { kind: "internal", targets: hit };
    }
    return { kind: "external", name: parts.slice(0, Math.min(2, parts.length - 1)).join(".") || spec };
  };

  // ------------------------------------------------------------ C / C++
  const byBase = new Map<string, string[]>();
  for (const p of input.paths) byBase.set(baseOf(p), [...(byBase.get(baseOf(p)) ?? []), p]);
  const includeDirs = [...new Set(input.paths.map(dirOf).filter((d) => /(^|\/)(include|inc|src)$/.test(d)))];
  /**
   * The recorded include has lost its delimiters, so `"x.h"` and `<x.h>` are
   * resolved alike: next to the including file, from the root, from include
   * directories, then by a unique path suffix.
   */
  const resolveInclude = (from: string, spec: string): Resolution => {
    const candidates = [posix.join(dirOf(from), spec), spec, ...includeDirs.map((d) => posix.join(d, spec))];
    for (const c of candidates) {
      const n = normal(c);
      if (exists(n)) return { kind: "internal", targets: [n] };
    }
    const bySuffix = (byBase.get(baseOf(spec)) ?? []).filter((p) => p === spec || p.endsWith(`/${spec}`));
    if (bySuffix.length === 1) return { kind: "internal", targets: bySuffix };
    if (spec.startsWith(".")) return { kind: "unresolved" };
    return isSystemInclude(spec) ? { kind: "builtin" } : { kind: "external", name: spec.split("/")[0]! };
  };

  return {
    resolve(from, language, spec) {
      switch (language) {
        case "javascript":
        case "typescript":
          return resolveJs(from, spec);
        case "python":
          return resolvePython(from, spec);
        case "java":
          return resolveJava(spec);
        case "c":
        case "cpp":
          return resolveInclude(from, spec);
        default:
          return { kind: "unresolved" };
      }
    },
    info: {
      tsconfigs: tsconfigs.size,
      pathAliases: [...tsconfigs.values()].reduce((n, c) => n + c.paths.length, 0),
      workspacePackages: packages.length,
      pythonRoots: [...pyRoots].filter((r) => r !== "").sort(),
    },
  };
}

/** C/C++ standard and platform headers (`<vector>` has no extension). */
function isSystemInclude(spec: string): boolean {
  return (
    !spec.includes(".") ||
    /^(assert|complex|ctype|errno|fenv|float|inttypes|iso646|limits|locale|math|setjmp|signal|stdalign|stdarg|stdatomic|stdbool|stddef|stdint|stdio|stdlib|stdnoreturn|string|tgmath|threads|time|uchar|wchar|wctype|unistd|fcntl|pthread|dirent|dlfcn|poll|termios|syslog|netdb|windows|winsock2|ws2tcpip)\.h$/.test(spec) ||
    /^(sys|netinet|arpa|linux|mach)\//.test(spec)
  );
}
