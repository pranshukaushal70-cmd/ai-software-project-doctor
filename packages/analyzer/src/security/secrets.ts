import type { Severity } from "@pd/shared/constants";
import type { FileKind } from "../scanner";
import { redactSecrets } from "../metrics/evidence";
import type { SecurityRuleKey } from "./rules";
import { downgrade, type RawSecurityFinding } from "./types";

/**
 * Secret detection over raw text. Runs on every text file (source, config,
 * docs, tests), line by line, and never lets a secret value reach evidence,
 * fingerprints or logs: values are masked as soon as they are matched.
 */

interface TokenPattern {
  rule: SecurityRuleKey;
  label: string;
  /** Global regex; capture group 1 is the secret value. */
  re: RegExp;
  severity: Severity;
  /** Leading characters that identify the token type and are safe to show (e.g. "ghp_"). */
  shown: number;
}

/** Well-known credential formats. Order matters: earlier patterns win on overlapping matches. */
const TOKEN_PATTERNS: TokenPattern[] = [
  { rule: "cloudCredential", label: "AWS secret access key", re: /aws.{0,25}?(?:secret|private)[\w.-]{0,20}["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi, severity: "CRITICAL", shown: 0 },
  { rule: "cloudCredential", label: "AWS access key ID", re: /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g, severity: "HIGH", shown: 4 },
  { rule: "cloudCredential", label: "Google API key", re: /\b(AIza[0-9A-Za-z_-]{35})(?![\w-])/g, severity: "HIGH", shown: 4 },
  { rule: "apiToken", label: "GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255})\b/g, severity: "CRITICAL", shown: 4 },
  { rule: "apiToken", label: "GitLab access token", re: /\b(glpat-[A-Za-z0-9_-]{20,})/g, severity: "CRITICAL", shown: 6 },
  { rule: "apiToken", label: "Slack token", re: /\b(xox[abposr]-[A-Za-z0-9-]{10,})/g, severity: "HIGH", shown: 5 },
  { rule: "apiToken", label: "Slack webhook URL", re: /(https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9_]{16,})/g, severity: "HIGH", shown: 33 },
  { rule: "apiToken", label: "Stripe live secret key", re: /\b((?:sk|rk)_live_[A-Za-z0-9]{16,})\b/g, severity: "CRITICAL", shown: 8 },
  { rule: "apiToken", label: "Stripe test secret key", re: /\b((?:sk|rk)_test_[A-Za-z0-9]{16,})\b/g, severity: "LOW", shown: 8 },
  { rule: "apiToken", label: "Anthropic API key", re: /\b(sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,})/g, severity: "CRITICAL", shown: 7 },
  { rule: "apiToken", label: "OpenAI API key", re: /\b(sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/g, severity: "CRITICAL", shown: 3 },
  { rule: "apiToken", label: "npm access token", re: /\b(npm_[A-Za-z0-9]{36})\b/g, severity: "CRITICAL", shown: 4 },
  { rule: "apiToken", label: "SendGrid API key", re: /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})/g, severity: "CRITICAL", shown: 3 },
  { rule: "jwt", label: "JSON Web Token", re: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g, severity: "MEDIUM", shown: 3 },
];

const PRIVATE_KEY_HEADER = /-----BEGIN ((?:RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED) )?PRIVATE KEY( BLOCK)?-----/;
const BASE64_LINE = /^[A-Za-z0-9+/=]{40,}$/;

const DB_URL = /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver):\/\/)([^:@\s/"'`]+):([^@\s"'`]+)@([^\s/:"'`?,;]+)/gi;
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|host\.docker\.internal)$/i;

/** Variable/key names that hold credentials. Bare "pass" is excluded (passenger, passthrough …). */
const SECRET_NAME = String.raw`(?:passw(?:or)?d|passphrase|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth[_-]?key)`;
/** name = "value", name: 'value', name => `value`, name := "value" (code, JSON, quoted YAML). */
const QUOTED_ASSIGNMENT = new RegExp(
  // The name starts at a word boundary, or right after an escaped newline inside a string ("…\nPASSWORD=…").
  String.raw`(?:(?<![\w$\\])|(?<=\\[nrt]))((?:[A-Za-z_$][\w$.-]*?)?${SECRET_NAME}[\w$.-]*)["']?\s*(?:=|:|:=|=>)\s*[rbuf]?(["'\`])([^"'\`\n\\]{6,200})\2`,
  "gi",
);
/** NAME=value / name: value without quotes (.env, YAML, .properties, INI, TOML). */
const BARE_ASSIGNMENT = new RegExp(
  String.raw`^\s*(?:export\s+|-\s+)?((?:[A-Za-z_][\w.-]*?)?${SECRET_NAME}[\w.-]*)\s*[:=]\s*(?!["'\s])([^\s#;,]{6,200})\s*(?:[#;].*)?$`,
  "i",
);
/** Names that mention a credential but hold metadata about it, not the credential itself. */
const NON_SECRET_NAME =
  /(?:url|uri|path|file|dir|name|type|kind|length|len|size|field|param|header|endpoint|regex|pattern|policy|expir\w*|ttl|timeout|count|max|min|id|label|placeholder|hint|prompt|message|msg|text|error|hash|rounds|format|mode|prefix|suffix|mask|class|style|column|env|var|input|selector|icon|title|description|route|tokenizer|tokens|limit|provider|strategy|store|storage|cache|version|algorithm|alg|scope|scopes|status|state|audience|issuer|enabled|required|visible|reset|confirm|confirmation|changed|valid|invalid|strength|rule|rules|schema|query)["']?$/i;
const BOOLEAN_NAME = /^(?:is|has|should|can|use|enable|disable|show|hide|require)[A-Z_]/;

const PLACEHOLDER_VALUE =
  /^(?:changeme|change[_-]?me|change[_-]?this|replace[_-]?me|password\d*|passw(?:or)?d|secret|token|example|sample|dummy|fake|mock|test(?:ing)?|placeholder|none|null|nil|undefined|true|false|empty|todo|tbd|redacted|default|foobar|foo|bar|your[_-].*|my[_-].*|insert[_-].*|enter[_-].*|put[_-].*|some[_-].*|(?:new|current)-password|one-time-code|same-origin|include|omit)$/i;

/** Documentation examples of real token formats (AWS's AKIAIOSFODNN7EXAMPLE, "sk_live_xxxx…"). */
function isTokenPlaceholder(value: string): boolean {
  return /example|placeholder|dummy|sample|your|x{6,}|\*{4,}|0{10,}|\$\{|[<>]/i.test(value);
}

/** Placeholder check for free-form values assigned to credential-like names. */
function isPlaceholder(value: string, name?: string): boolean {
  const v = value.trim();
  if (PLACEHOLDER_VALUE.test(v)) return true;
  if (/\s/.test(v)) return true; // prose, labels ("Enter your password")
  if (/^(.)\1+$/.test(v)) return true; // xxxxxx, ******
  if (/^[<[{(%$]|^\{\{|\$\{|\$\(|%\(|<redacted>|\.\.\.|…/.test(v)) return true; // templates and references
  if (/^(?:process\.env|os\.environ|os\.getenv|env\(|getenv|System\.getenv|config\.|settings\.)/i.test(v)) return true;
  if (/^[A-Z][A-Z0-9_]*$/.test(v)) return true; // a constant or env-var name, not a value
  if (/^[a-z][\w-]*(?:\.[\w-]+)+$/i.test(v) && !/\d/.test(v)) return true; // dotted identifiers / i18n keys
  if (/^(?:https?|file):\/\//i.test(v) && !/:[^/@]+@/.test(v)) return true;
  if (/^\/|^\.\.?\//.test(v)) return true; // file paths
  if (name && v.replace(/[\W_]/g, "").toLowerCase() === name.replace(/[\W_]/g, "").toLowerCase()) return true;
  return false;
}

/** Mask a secret, keeping only a non-secret identifying prefix. */
export function maskSecret(value: string, shown = 0): string {
  return `${value.slice(0, Math.min(shown, Math.floor(value.length / 3)))}…[redacted]`;
}

const MAX_CONTEXT = 140;

/** The line with the secret replaced by its mask, cut to a window around the match. */
function maskedContext(line: string, start: number, end: number, mask: string): string {
  const masked = `${line.slice(0, start)}${mask}${line.slice(end)}`;
  const maskStart = start;
  let from = Math.max(0, maskStart - 60);
  let to = Math.min(masked.length, from + MAX_CONTEXT);
  if (to - from < MAX_CONTEXT) from = Math.max(0, to - MAX_CONTEXT);
  const text = `${from > 0 ? "…" : ""}${masked.slice(from, to).trim()}${to < masked.length ? "…" : ""}`;
  // Second line of defence: anything else on the line that looks like a credential.
  return redactSecrets(text.replace(/\s+/g, " ")).replace(/`/g, "'");
}

export interface SecretScanFile {
  path: string;
  kind: FileKind;
  /** Committed .env-style file (not a template such as .env.example). */
  isEnvFile: boolean;
  isEnvTemplate: boolean;
}

const MAX_FINDINGS_PER_FILE = 50;
/** Lines longer than this (minified bundles, data blobs) only get the anchored token patterns. */
const MAX_GENERIC_LINE = 4000;
const CONFIG_EXT = /\.(?:env|ya?ml|properties|ini|toml|cfg|conf|config)$|(?:^|\/)\.env[^/]*$|(?:^|\/)[^/.]*\.env$/i;

interface Match {
  rule: SecurityRuleKey;
  label: string;
  severity: Severity;
  line: number;
  start: number;
  end: number;
  value: string;
  shown: number;
  name?: string;
  note?: string;
}

/**
 * Find secrets in one file's text. Severity is lowered one step in tests and
 * documentation (usually fixtures and examples) and the evidence says so.
 */
export function scanTextForSecrets(text: string, file: SecretScanFile): RawSecurityFinding[] {
  const lines = text.split(/\r?\n/);
  const matches: Match[] = [];
  const isConfig = file.isEnvFile || file.isEnvTemplate || CONFIG_EXT.test(file.path) || file.kind === "CONFIG";
  const nonProduction = file.kind === "TEST" || file.kind === "DOCUMENTATION";

  for (let i = 0; i < lines.length && matches.length < MAX_FINDINGS_PER_FILE; i++) {
    const line = lines[i]!;
    if (line.length < 8) continue;
    const taken: Array<[number, number]> = [];
    const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);

    const pk = PRIVATE_KEY_HEADER.exec(line);
    if (pk && looksLikePemBody(lines, i, line.slice(pk.index + pk[0].length))) {
      matches.push({ rule: "privateKey", label: `${pk[1] ?? ""}private key`.trim(), severity: "CRITICAL", line: i, start: pk.index, end: pk.index + pk[0].length, value: pk[0], shown: pk[0].length });
      taken.push([pk.index, line.length]);
    }

    for (const p of TOKEN_PATTERNS) {
      for (const m of line.matchAll(p.re)) {
        const value = m[1]!;
        const start = m.index + m[0].lastIndexOf(value);
        const end = start + value.length;
        if (overlaps(start, end) || isTokenPlaceholder(value)) continue;
        taken.push([start, end]);
        matches.push({ rule: p.rule, label: p.label, severity: p.severity, line: i, start, end, value, shown: p.shown });
      }
    }

    for (const m of line.matchAll(DB_URL)) {
      const password = m[3]!;
      const start = m.index + m[1]!.length + m[2]!.length + 1;
      const end = start + password.length;
      if (overlaps(start, end) || isPlaceholder(password) || password === m[2]) continue;
      const local = LOCAL_HOST.test(m[4]!);
      taken.push([start, end]);
      matches.push({
        rule: "databaseUrl",
        label: "Connection string password",
        severity: local ? "LOW" : "HIGH",
        line: i,
        start,
        end,
        value: password,
        shown: 0,
        note: local ? "the host is local, so this is likely a development credential" : undefined,
      });
    }

    if (line.length > MAX_GENERIC_LINE || file.isEnvTemplate) continue;
    const generic = (name: string, value: string, start: number) => {
      const end = start + value.length;
      if (overlaps(start, end) || NON_SECRET_NAME.test(name) || BOOLEAN_NAME.test(name) || isPlaceholder(value, name)) return;
      taken.push([start, end]);
      const severity: Severity = file.isEnvFile || file.kind === "SOURCE" ? "HIGH" : "MEDIUM";
      matches.push({ rule: "hardcodedSecret", label: `Value assigned to \`${name}\``, severity, line: i, start, end, value, shown: 0, name });
    };
    for (const m of line.matchAll(QUOTED_ASSIGNMENT)) {
      const value = m[3]!;
      // `cond ? "a" : "b"` — a ternary's colon is not an assignment.
      if (/\?\s*["'`]?$/.test(line.slice(0, m.index))) continue;
      generic(m[1]!, value, m.index + m[0].length - value.length - 1);
    }
    if (isConfig) {
      const m = BARE_ASSIGNMENT.exec(line);
      if (m) generic(m[1]!, m[2]!, line.indexOf(m[2]!, m.index + m[1]!.length));
    }
  }

  return matches.map((m) => {
    const severity = nonProduction ? downgrade(m.severity) : m.severity;
    const mask = m.rule === "privateKey" ? m.value : maskSecret(m.value, m.shown);
    const context = maskedContext(lines[m.line]!, m.start, m.end, mask);
    const notes = [m.note, nonProduction && `found in a ${file.kind === "TEST" ? "test" : "documentation"} file, so it may be a fixture or example`].filter(Boolean);
    return {
      rule: m.rule,
      severity,
      line: m.line + 1,
      endLine: m.line + 1,
      evidence: `${m.label} at line ${m.line + 1}: \`${context}\`${notes.length ? ` (${notes.join("; ")})` : ""}.`,
      key: `${m.label}:${m.name ?? `${mask}#${m.value.length}`}`,
      data: { label: m.label.replace(/`/g, ""), masked: mask, ...(m.name ? { name: m.name } : {}) },
    };
  });
}

/** A PEM header only counts if key material follows (not code that merely mentions the header). */
function looksLikePemBody(lines: string[], i: number, restOfLine: string): boolean {
  if (/^(?:\\r)?\\n[A-Za-z0-9+/=]{40,}/.test(restOfLine)) return true; // "-----BEGIN…-----\nMIIE…" in one string
  for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
    const l = lines[j]!.trim().replace(/^["'`]|["'`,;+\s\\n]+$/g, "");
    if (l === "" || /^(?:Proc-Type|DEK-Info|Comment):/i.test(l)) continue;
    return BASE64_LINE.test(l);
  }
  return false;
}

/** A committed .env file that assigns at least one non-empty value. */
export function envFileFinding(text: string, path: string): RawSecurityFinding | null {
  const assigned = text
    .split(/\r?\n/)
    .map((l) => /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null && m[2]!.replace(/^["']|["']$/g, "").trim() !== "");
  if (assigned.length === 0) return null;
  const names = assigned.slice(0, 8).map((m) => m[1]);
  return {
    rule: "committedEnvFile",
    severity: "MEDIUM",
    line: 1,
    endLine: 1,
    evidence: `\`${path}\` is committed and assigns ${assigned.length} value${assigned.length === 1 ? "" : "s"} (${names.join(", ")}${assigned.length > names.length ? ", …" : ""}). Values are not shown.`,
    key: "env-file",
    data: { variables: assigned.length },
  };
}
