// The dependency-free redaction module, not "@pd/analyzer/metrics" (which loads the tree-sitter parser).
import { redactSecrets } from "@pd/analyzer/evidence";

/** Stored output per execution. The end is kept: test runners report failures and totals last. */
export const OUTPUT_LIMIT_BYTES = 64 * 1024;
/** While a command runs, at most this much is buffered (the tail is kept). */
const BUFFER_LIMIT_BYTES = 4 * OUTPUT_LIMIT_BYTES;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Collects a stream's text, keeping only the most recent BUFFER_LIMIT_BYTES. */
export class TailBuffer {
  private chunks: string[] = [];
  private size = 0;
  dropped = false;

  push(text: string): void {
    this.chunks.push(text);
    this.size += text.length;
    while (this.size > BUFFER_LIMIT_BYTES && this.chunks.length > 1) {
      this.size -= this.chunks.shift()!.length;
      this.dropped = true;
    }
    if (this.size > BUFFER_LIMIT_BYTES) {
      const only = this.chunks[0]!;
      this.chunks[0] = only.slice(only.length - BUFFER_LIMIT_BYTES);
      this.size = this.chunks[0].length;
      this.dropped = true;
    }
  }

  text(): string {
    return this.chunks.join("");
  }
}

/**
 * Output as stored and shown: terminal escapes and control characters removed,
 * line endings normalised, credentials redacted (repository code can print
 * anything, including values from files it reads), and only the last
 * OUTPUT_LIMIT_BYTES kept.
 */
export function sanitizeOutput(raw: string, alreadyTruncated = false): { output: string; truncated: boolean } {
  let text = raw.replace(ANSI, "").replace(/\r\n?/g, "\n").replace(CONTROL, "");
  text = redactSecrets(text);
  let truncated = alreadyTruncated;
  if (Buffer.byteLength(text, "utf8") > OUTPUT_LIMIT_BYTES) {
    truncated = true;
    let tail = text.slice(text.length - OUTPUT_LIMIT_BYTES);
    while (Buffer.byteLength(tail, "utf8") > OUTPUT_LIMIT_BYTES) tail = tail.slice(1024);
    // Start at a line boundary.
    const nl = tail.indexOf("\n");
    text = nl >= 0 && nl < 1024 ? tail.slice(nl + 1) : tail;
  }
  return { output: truncated ? `[earlier output truncated]\n${text}` : text, truncated };
}
