import type { Severity } from "@pd/shared/constants";
import type { CodeFinding } from "../metrics";
import type { ScannedFile } from "../scanner";
import type { PracticeCategory, PracticeRuleKey } from "./rules";

export interface PracticeFinding extends Omit<CodeFinding, "category" | "line" | "endLine"> {
  category: PracticeCategory;
  line: number | null;
  endLine: number | null;
}

/** A finding before it is fingerprinted. `path` is "" for repository-level findings (no README, no tests …). */
export interface RawPracticeFinding {
  rule: PracticeRuleKey;
  path: string;
  severity: Severity;
  line: number | null;
  /** Human-readable evidence. Never contains secret values: only names, paths and redacted snippets. */
  evidence: string;
  /** Stable identity within the path, so triage follows the finding across re-analyses. */
  key: string;
  data?: Record<string, unknown>;
}

/** A repository file with its text, as read once by the practices analyzer and shared by its parts. */
export interface TextFile {
  path: string;
  language: string | null;
  kind: ScannedFile["kind"];
  text: string;
}

/** Maps character offsets to 1-based line numbers (binary search over line starts). */
export function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
