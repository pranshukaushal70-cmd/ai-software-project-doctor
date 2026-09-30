const MAX_SNIPPET = 160;

const SECRET_KEY = /(?:pass(?:word|wd)?|secret|token|api[_-]?key|private[_-]?key|credential|auth)/i;
/** Quoted value assigned to a secret-looking name: password = "…", apiKey: '…'. */
const SECRET_ASSIGNMENT = new RegExp(`(${SECRET_KEY.source}\\w*["']?\\s*[:=]\\s*)(["'\`])[^"'\`]*\\2`, "gi");
/**
 * Long unbroken quoted tokens look like keys or tokens when they mix letters
 * and digits, or when the value itself names a credential ("…_secret_key").
 */
const OPAQUE_LITERAL = /(["'`])([A-Za-z0-9+/=_\-.]{20,})\1/g;
/** Well-known credential formats, masked wherever they appear (also unquoted, e.g. in comments). */
const KNOWN_TOKEN = new RegExp(
  [
    String.raw`\b[spr]k_(?:live|test)_[A-Za-z0-9]{8,}`, // Stripe
    String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`, // GitHub
    String.raw`\bgithub_pat_\w{20,}`,
    String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`, // Slack
    String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, // AWS access key id
    String.raw`\bAIza[0-9A-Za-z_-]{35}`, // Google API key
    String.raw`\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}`, // JWT
  ].join("|"),
  "g",
);

/**
 * Redact values that may be credentials. Evidence snippets are persisted and
 * later sent to an LLM, so anything that looks like a secret is masked here.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(KNOWN_TOKEN, "<redacted>")
    .replace(SECRET_ASSIGNMENT, (_m, prefix: string, quote: string) => `${prefix}${quote}<redacted>${quote}`)
    .replace(OPAQUE_LITERAL, (m, quote: string, body: string) =>
      (/[A-Za-z]/.test(body) && /\d/.test(body)) || SECRET_KEY.test(body) ? `${quote}<redacted>${quote}` : m,
    );
}

/** A single-line, whitespace-collapsed, truncated and redacted code excerpt. */
export function snippet(text: string, max = MAX_SNIPPET): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const collapsed = redactSecrets(firstLine.trim().replace(/\s+/g, " "));
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

export const plural = (n: number, word: string, suffix = "s") => `${n} ${word}${n === 1 ? "" : suffix}`;
