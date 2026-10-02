/**
 * Just enough TOML to read dependency tables: section headers, array tables,
 * `key = value` pairs (values kept raw), multi-line arrays and inline tables.
 * Not a general TOML parser; unknown constructs are skipped, never thrown on.
 */
export type TomlEvent =
  | { type: "table"; name: string; array: boolean; line: number }
  | { type: "kv"; key: string; value: string; line: number };

/** Strip a trailing comment that is not inside a string. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

/** Net bracket depth change of a value fragment, ignoring brackets inside strings. */
function bracketDelta(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth;
}

const unquoteKey = (k: string) => k.trim().replace(/^["']|["']$/g, "");

export function* readToml(text: string): Generator<TomlEvent> {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]!).trim();
    if (!line) continue;
    const header = /^(\[\[?)\s*([^\]]+?)\s*\]\]?$/.exec(line);
    if (header) {
      const name = header[2]!
        .split(".")
        .map(unquoteKey)
        .join(".");
      yield { type: "table", name, array: header[1] === "[[", line: i + 1 };
      continue;
    }
    const eq = /^((?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)(?:\s*\.\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=\s*(.*)$/.exec(line);
    if (!eq) continue;
    const start = i + 1;
    let value = eq[2]!;
    let depth = bracketDelta(value);
    // Multi-line arrays and inline tables continue until their brackets balance (bounded).
    while (depth > 0 && i + 1 < lines.length && i - start < 5000) {
      const next = stripComment(lines[++i]!).trim();
      value += ` ${next}`;
      depth += bracketDelta(next);
    }
    yield { type: "kv", key: eq[1]!.split(".").map(unquoteKey).join("."), value: value.trim(), line: start };
  }
}

/** Value of a quoted TOML string, or null when the value is not a string. */
export function tomlString(raw: string): string | null {
  const m = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(raw.trim());
  if (!m) return null;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]!;
}

/** Top-level string-valued keys of an inline table (`{ version = "1.0", path = "../x" }`); nested values are ignored. */
export function tomlInlineTable(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = raw.trim();
  if (!body.startsWith("{")) return out;
  for (const m of body.matchAll(/([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*'|true|false)/g)) {
    const key = m[1]!;
    const v = m[2]!;
    out[key] = v === "true" || v === "false" ? v : (tomlString(v) ?? "");
  }
  return out;
}

/** String items of an array value. */
export function tomlStringArray(raw: string): string[] {
  if (!raw.trim().startsWith("[")) return [];
  return [...raw.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]!));
}
