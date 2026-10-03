/**
 * Unified diffs for proposed changes, in git's format so a downloaded patch applies
 * with `git apply`. Lines are compared exactly, including their terminator, so a
 * line-ending change is visible. Myers' algorithm on the part between the common
 * prefix and suffix; past MAX_EDIT_DISTANCE the remaining block is shown as one
 * replacement (still a correct diff, just a less minimal one), which bounds time
 * and memory on hostile or huge rewrites.
 */

export interface FileDiff {
  /** The patch for this file; empty when nothing changed. */
  diff: string;
  additions: number;
  deletions: number;
}

const CONTEXT = 3;
const MAX_EDIT_DISTANCE = 4000;

/** Splits text into lines that keep their terminator ("\n" or "\r\n"); the last line may have none. */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

type Op = { kind: " " | "-" | "+"; line: string; a: number; b: number };

/** Edit script between two line arrays: every line of `a` and `b` exactly once, in order. */
export function diffLines(a: string[], b: string[]): Op[] {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const ops: Op[] = [];
  for (let i = 0; i < pre; i++) ops.push({ kind: " ", line: a[i]!, a: i, b: i });
  ops.push(...myers(a, b, pre, a.length - suf, pre, b.length - suf));
  for (let i = suf; i > 0; i--) ops.push({ kind: " ", line: a[a.length - i]!, a: a.length - i, b: b.length - i });
  return ops;
}

function myers(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number): Op[] {
  const n = a1 - a0;
  const m = b1 - b0;
  const replaceAll = (): Op[] => [
    ...Array.from({ length: n }, (_, i) => ({ kind: "-" as const, line: a[a0 + i]!, a: a0 + i, b: b0 })),
    ...Array.from({ length: m }, (_, j) => ({ kind: "+" as const, line: b[b0 + j]!, a: a1, b: b0 + j })),
  ];
  if (n === 0 || m === 0) return replaceAll();
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return replaceAll();

  // Walk the trace back from (n, m) to (0, 0).
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d]!;
    const k = x - y;
    const down = k === -d || (k !== d && prev[offset + k - 1]! < prev[offset + k + 1]!);
    const pk = down ? k + 1 : k - 1;
    const px = prev[offset + pk]!;
    const py = px - pk;
    while (x > px + (down ? 0 : 1) && y > py + (down ? 1 : 0)) {
      x--;
      y--;
      ops.push({ kind: " ", line: a[a0 + x]!, a: a0 + x, b: b0 + y });
    }
    if (down) {
      y--;
      ops.push({ kind: "+", line: b[b0 + y]!, a: a0 + x, b: b0 + y });
    } else {
      x--;
      ops.push({ kind: "-", line: a[a0 + x]!, a: a0 + x, b: b0 + y });
    }
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    ops.push({ kind: " ", line: a[a0 + x]!, a: a0 + x, b: b0 + y });
  }
  return ops.reverse();
}

const NO_NEWLINE = "\\ No newline at end of file\n";

function hunkLines(ops: Op[]): string {
  let out = "";
  for (const op of ops) {
    const terminated = op.line.endsWith("\n");
    out += op.kind + (terminated ? op.line : `${op.line}\n${NO_NEWLINE}`);
  }
  return out;
}

const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);

/**
 * The git-format patch turning `before` into `after` for `path`. `before` null is a
 * new file, `after` null a deleted file. Paths are repository-relative and were
 * validated by the caller.
 */
export function unifiedDiff(path: string, before: string | null, after: string | null): FileDiff {
  if (before === after) return { diff: "", additions: 0, deletions: 0 };
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");
  const ops = diffLines(a, b);
  const additions = ops.filter((o) => o.kind === "+").length;
  const deletions = ops.filter((o) => o.kind === "-").length;

  let header = `diff --git a/${path} b/${path}\n`;
  if (before === null) header += "new file mode 100644\n";
  if (after === null) header += "deleted file mode 100644\n";
  header += `--- ${before === null ? "/dev/null" : `a/${path}`}\n+++ ${after === null ? "/dev/null" : `b/${path}`}\n`;
  if (additions === 0 && deletions === 0) return { diff: "", additions, deletions };

  // Group changes into hunks with CONTEXT lines around them.
  let body = "";
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === " ") {
      i++;
      continue;
    }
    const start = Math.max(0, i - CONTEXT);
    let end = i;
    // Extend while the next change is within 2 * CONTEXT unchanged lines.
    for (;;) {
      while (end < ops.length && ops[end]!.kind !== " ") end++;
      let next = end;
      while (next < ops.length && ops[next]!.kind === " ") next++;
      if (next < ops.length && next - end <= 2 * CONTEXT) end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + CONTEXT);
    const hunk = ops.slice(start, stop);
    const oldCount = hunk.filter((o) => o.kind !== "+").length;
    const newCount = hunk.filter((o) => o.kind !== "-").length;
    const first = hunk[0]!;
    // Line numbers are 1-based; an empty side starts at the line before (git's convention).
    const oldStart = oldCount === 0 ? first.a : first.a + 1;
    const newStart = newCount === 0 ? first.b : first.b + 1;
    body += `@@ -${range(oldStart, oldCount)} +${range(newStart, newCount)} @@\n${hunkLines(hunk)}`;
    i = stop;
  }
  return { diff: header + body, additions, deletions };
}
