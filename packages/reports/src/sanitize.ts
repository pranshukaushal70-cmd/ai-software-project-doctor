// The dependency-free redaction module, not "@pd/analyzer/metrics" (which loads the tree-sitter parser).
import { redactSecrets } from "@pd/analyzer/evidence";

/**
 * Last line of defence for report snapshots: every string is passed through the
 * analyzer's secret redaction (the same patterns as finding evidence and the code
 * engine), stripped of control characters (terminal escapes included) and bounded.
 * Stored data was redacted before already; this keeps a report safe even if a
 * stored string (task text, model prose, test output) slipped through.
 * Untrusted text stays text: rendering is the UI's job, which escapes it.
 */

/** Longest string kept in a snapshot (test-output tails are bounded separately, before this). */
export const MAX_REPORT_STRING = 4000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function cleanText(text: string, max = MAX_REPORT_STRING): string {
  let t = redactSecrets(text.replace(/\r\n?/g, "\n").replace(CONTROL, ""));
  if (t.length > max) t = `${t.slice(0, max - 1)}…`;
  return t;
}

/** Applies cleanText to every string in a JSON-like value, keeping its shape and key order. */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") return cleanText(value) as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v);
    return out as T;
  }
  return value;
}
