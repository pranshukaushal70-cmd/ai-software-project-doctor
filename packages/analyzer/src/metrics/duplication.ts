import type { TokenStream } from "./file-analyzer";

export interface DuplicationInput {
  path: string;
  tokens: TokenStream;
}

export interface Clone {
  /** The earlier occurrence (by file order, then position). */
  original: { path: string; startLine: number; endLine: number };
  duplicate: { path: string; startLine: number; endLine: number };
  tokens: number;
  lines: number;
  /** Hash of the cloned token sequence, stable across runs. */
  hash: string;
}

export interface DuplicationResult {
  clones: Clone[];
  /** Distinct duplicated line numbers (1-based) per file, counting both sides of every clone. */
  duplicatedLines: Map<string, Set<number>>;
  tokensIndexed: number;
  truncated: boolean;
}

export interface DuplicationOptions {
  minTokens: number;
  minLines: number;
  /** Stop indexing beyond this many tokens to bound memory on huge repositories. */
  maxTokens: number;
}

const BASE = 0x01000193;

/**
 * Exact-clone detection (whitespace and comments ignored) over token streams.
 * Windows of `minTokens` tokens are hashed with a rolling hash; every hash hit
 * is verified token by token, extended as far as the sequences match, and the
 * duplicate side is skipped past so overlapping windows are reported once.
 */
export function findDuplicates(inputs: DuplicationInput[], opts: DuplicationOptions): DuplicationResult {
  const W = opts.minTokens;
  const clones: Clone[] = [];
  const duplicatedLines = new Map<string, Set<number>>();
  /** window hash → first occurrence as (file index, token index) */
  const index = new Map<number, number[]>();
  let tokensIndexed = 0;
  let truncated = false;

  // BASE^(W-1) for removing the outgoing token from the rolling hash.
  let highPow = 1;
  for (let i = 0; i < W - 1; i++) highPow = Math.imul(highPow, BASE);

  const markLines = (path: string, from: number, to: number) => {
    let set = duplicatedLines.get(path);
    if (!set) duplicatedLines.set(path, (set = new Set()));
    for (let l = from; l <= to; l++) set.add(l);
  };

  for (let fi = 0; fi < inputs.length; fi++) {
    const { hashes, rows } = inputs[fi]!.tokens;
    const n = hashes.length;
    if (n < W) continue;
    if (tokensIndexed + n > opts.maxTokens) {
      truncated = true;
      break;
    }
    tokensIndexed += n;

    let h = 0;
    for (let k = 0; k < W; k++) h = (Math.imul(h, BASE) + hashes[k]!) | 0;

    let i = 0;
    while (i + W <= n) {
      const hits = index.get(h);
      let matched = false;
      if (hits) {
        for (let c = 0; c < hits.length && !matched; c += 2) {
          const ofi = hits[c]!;
          const oi = hits[c + 1]!;
          const other = inputs[ofi]!.tokens;
          // Same-file matches must not overlap.
          if (ofi === fi && oi + W > i) continue;
          let len = 0;
          const limit = ofi === fi ? Math.min(n - i, i - oi) : Math.min(n - i, other.hashes.length - oi);
          while (len < limit && other.hashes[oi + len] === hashes[i + len]) len++;
          if (len < W) continue; // hash collision

          // Report whole lines only: drop tokens that share a line with non-duplicated code.
          let s = 0;
          while (s < len && i + s > 0 && rows[i + s - 1] === rows[i + s]) s++;
          let e = len - 1;
          while (e > s && i + e + 1 < n && rows[i + e + 1] === rows[i + e]) e--;
          if (e - s + 1 < W) continue;

          const dupStart = rows[i + s]! + 1;
          const dupEnd = rows[i + e]! + 1;
          const origStart = other.rows[oi + s]! + 1;
          const origEnd = other.rows[oi + e]! + 1;
          const lines = dupEnd - dupStart + 1;
          if (lines < opts.minLines) continue;

          let seqHash = 0x811c9dc5;
          for (let k = s; k <= e; k++) seqHash = Math.imul(seqHash ^ hashes[i + k]!, BASE);
          clones.push({
            original: { path: inputs[ofi]!.path, startLine: origStart, endLine: origEnd },
            duplicate: { path: inputs[fi]!.path, startLine: dupStart, endLine: dupEnd },
            tokens: e - s + 1,
            lines,
            hash: (seqHash >>> 0).toString(16).padStart(8, "0"),
          });
          markLines(inputs[ofi]!.path, origStart, origEnd);
          markLines(inputs[fi]!.path, dupStart, dupEnd);

          // Skip past the clone, recomputing the window hash at the new position.
          i += len;
          if (i + W <= n) {
            h = 0;
            for (let k = 0; k < W; k++) h = (Math.imul(h, BASE) + hashes[i + k]!) | 0;
          }
          matched = true;
        }
      }
      if (matched) continue;

      if (hits) {
        if (hits.length < 16) hits.push(fi, i); // bounded bucket: very common windows (boilerplate) keep a few occurrences
      } else {
        index.set(h, [fi, i]);
      }
      if (i + W < n) h = (Math.imul(h - Math.imul(hashes[i]!, highPow), BASE) + hashes[i + W]!) | 0;
      i++;
    }
  }

  return { clones, duplicatedLines, tokensIndexed, truncated };
}
