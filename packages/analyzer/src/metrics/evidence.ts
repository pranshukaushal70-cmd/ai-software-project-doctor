const MAX_SNIPPET = 160;

const SECRET_KEY = /(?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|credential|auth)/i;
/** Quoted value assigned to a secret-looking name: password = "…", apiKey: '…'. */
const SECRET_ASSIGNMENT = new RegExp(`(${SECRET_KEY.source}\\w*["']?\\s*[:=]\\s*)(["'\`])[^"'\`]*\\2`, "gi");
/** Long unbroken quoted tokens containing both letters and digits look like keys or tokens. */
const OPAQUE_LITERAL = /(["'`])([A-Za-z0-9+/=_\-.]{20,})\1/g;

/**
 * Redact values that may be credentials. Evidence snippets are persisted and
 * later sent to an LLM, so anything that looks like a secret is masked here.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_ASSIGNMENT, (_m, prefix: string, quote: string) => `${prefix}${quote}<redacted>${quote}`)
    .replace(OPAQUE_LITERAL, (m, quote: string, body: string) =>
      /[A-Za-z]/.test(body) && /\d/.test(body) ? `${quote}<redacted>${quote}` : m,
    );
}

/** A single-line, whitespace-collapsed, truncated and redacted code excerpt. */
export function snippet(text: string, max = MAX_SNIPPET): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const collapsed = redactSecrets(firstLine.trim().replace(/\s+/g, " "));
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

export const plural = (n: number, word: string, suffix = "s") => `${n} ${word}${n === 1 ? "" : suffix}`;
