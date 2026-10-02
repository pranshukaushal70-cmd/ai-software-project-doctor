import { readToml, tomlInlineTable, tomlString } from "./toml";
import type { DependencyRecord, DependencySource, ParsedManifest } from "./types";

/** go.mod `require` directives. `// indirect` requirements are transitive. Versions are always exact. */
export function parseGoMod(path: string, text: string): ParsedManifest {
  const deps: DependencyRecord[] = [];
  const replaced = new Set<string>();
  const lines = text.split(/\r?\n/);
  let block: "require" | "replace" | null = null;
  const add = (spec: string, line: number) => {
    const m = /^\s*(\S+)\s+(v\S+)\s*(\/\/.*)?$/.exec(spec);
    if (!m) return;
    const [, name, version, comment] = m as unknown as [string, string, string, string | undefined];
    deps.push({
      ecosystem: "Go",
      name,
      versionSpec: version,
      resolvedVersion: version,
      direct: !/\bindirect\b/.test(comment ?? ""),
      dev: false,
      manifestPath: path,
      line,
      source: "registry",
      publicRegistry: true,
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (block) {
      if (line === ")") block = null;
      else if (block === "require") add(line, i + 1);
      else {
        const r = /^(\S+)(?:\s+\S+)?\s*=>\s*(\S+)/.exec(line);
        if (r && /^(\.|\/)/.test(r[2]!)) replaced.add(r[1]!);
      }
      continue;
    }
    const open = /^(require|replace)\s*\($/.exec(line);
    if (open) {
      block = open[1] as "require" | "replace";
      continue;
    }
    const single = /^require\s+(.+)$/.exec(line);
    if (single) add(single[1]!, i + 1);
    const rep = /^replace\s+(\S+)(?:\s+\S+)?\s*=>\s*(\S+)/.exec(line);
    if (rep && /^(\.|\/)/.test(rep[2]!)) replaced.add(rep[1]!);
  }
  // Modules replaced by a local directory are not the published module.
  for (const d of deps) {
    if (replaced.has(d.name)) {
      d.source = "path";
      d.resolvedVersion = null;
    }
  }
  return { path, ecosystem: "Go", kind: "manifest", dependencies: deps };
}

/** Exact Cargo requirement (`=1.2.3`); a bare `1.2.3` in Cargo means `^1.2.3`. */
export function exactCargoVersion(spec: string): string | null {
  const m = /^\s*=\s*(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/.exec(spec);
  return m ? m[1]! : null;
}

/** Cargo.toml `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]` and target-specific tables. */
export function parseCargoToml(path: string, text: string): ParsedManifest {
  const deps: DependencyRecord[] = [];
  let table = "";
  for (const ev of readToml(text)) {
    if (ev.type === "table") {
      table = ev.name;
      // `[dependencies.serde]` table form.
      const sub = /^(?:target\..+\.)?(dependencies|dev-dependencies|build-dependencies)\.([^.]+)$/.exec(table);
      if (sub) {
        deps.push({
          ecosystem: "crates.io",
          name: sub[2]!,
          versionSpec: null,
          resolvedVersion: null,
          direct: true,
          dev: sub[1] === "dev-dependencies",
          manifestPath: path,
          line: ev.line,
          source: "registry",
          publicRegistry: true,
        });
      }
      continue;
    }
    const sub = /^(?:target\..+\.)?(dependencies|dev-dependencies|build-dependencies)\.([^.]+)$/.exec(table);
    if (sub) {
      const dep = deps.at(-1);
      if (!dep || dep.name !== sub[2]) continue;
      const v = tomlString(ev.value);
      if (ev.key === "version" && v) {
        dep.versionSpec = v;
        dep.resolvedVersion = exactCargoVersion(v);
      } else if (ev.key === "git") dep.source = "git";
      else if (ev.key === "path") dep.source = "path";
      else if (ev.key === "workspace" && ev.value === "true") dep.source = "workspace";
      continue;
    }
    const section = /^(?:target\..+\.)?(dependencies|dev-dependencies|build-dependencies)$/.exec(table);
    if (!section) continue;
    const str = tomlString(ev.value);
    const inline = tomlInlineTable(ev.value);
    const spec = str ?? inline.version ?? null;
    const source: DependencySource = inline.git ? "git" : inline.path ? "path" : inline.workspace === "true" ? "workspace" : "registry";
    deps.push({
      ecosystem: "crates.io",
      name: inline.package ?? ev.key,
      versionSpec: spec,
      resolvedVersion: spec && source === "registry" ? exactCargoVersion(spec) : null,
      direct: true,
      dev: section[1] === "dev-dependencies",
      manifestPath: path,
      line: ev.line,
      source,
      publicRegistry: true,
    });
  }
  return { path, ecosystem: "crates.io", kind: "manifest", dependencies: deps };
}

/** Cargo.lock `[[package]]` entries from crates.io (local and git crates have no registry source). */
export function parseCargoLock(text: string): Array<{ name: string; version: string; line: number; publicRegistry: boolean }> {
  const out: Array<{ name: string; version: string; line: number; publicRegistry: boolean }> = [];
  let cur: { name?: string; version?: string; source?: string; line: number } | null = null;
  const flush = () => {
    if (cur?.name && cur.version && cur.source?.startsWith("registry+")) {
      out.push({ name: cur.name, version: cur.version, line: cur.line, publicRegistry: /crates\.io-index|index\.crates\.io/.test(cur.source) });
    }
  };
  for (const ev of readToml(text)) {
    if (ev.type === "table") {
      flush();
      cur = ev.array && ev.name === "package" ? { line: ev.line } : null;
      continue;
    }
    if (!cur) continue;
    if (ev.key === "name") cur.name = tomlString(ev.value) ?? undefined;
    else if (ev.key === "version") cur.version = tomlString(ev.value) ?? undefined;
    else if (ev.key === "source") cur.source = tomlString(ev.value) ?? undefined;
  }
  flush();
  return out;
}
