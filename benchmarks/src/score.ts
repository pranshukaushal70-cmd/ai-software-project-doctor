import type { GroundTruth } from "./ground-truth";

/**
 * Matches an analyzer's findings against a fixture's ground truth and computes precision
 * and recall. Pure and deterministic.
 *
 * A finding matches an expected issue when the rule is the same, the file is the expected
 * `path` (or one of `paths`), and, if the issue has a line span, the finding's line lies
 * in it. Each expected issue is matched once; further findings of the same issue (for
 * example one per file of a cycle) are counted as duplicates, neither true nor false.
 */

export interface ScoredFinding {
  ruleId: string;
  category: string;
  path: string | null;
  line: number | null;
}

export interface FixtureScore {
  fixture: string;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  duplicates: number;
  acceptable: number;
  outOfScope: number;
  matched: { ruleId: string; path: string | null; line: number | null }[];
  missed: { ruleId: string; path: string | null; lines: [number, number] | null; why: string }[];
  unexpected: ScoredFinding[];
}

type Location = Pick<GroundTruth["expected"][number], "ruleId" | "path" | "paths" | "lines">;

export function locates(loc: Location, f: ScoredFinding): boolean {
  if (loc.ruleId !== f.ruleId) return false;
  const files = loc.paths ?? (loc.path !== undefined ? [loc.path] : null);
  if (files && (f.path === null || !files.includes(f.path))) return false;
  if (loc.lines && (f.line === null || f.line < loc.lines[0] || f.line > loc.lines[1])) return false;
  return true;
}

const byPosition = (a: ScoredFinding, b: ScoredFinding) =>
  (a.path ?? "").localeCompare(b.path ?? "") || (a.line ?? 0) - (b.line ?? 0) || a.ruleId.localeCompare(b.ruleId);

export function scoreFixture(truth: GroundTruth, findings: readonly ScoredFinding[]): FixtureScore {
  const labeled = new Set(truth.labeledCategories);
  const matchedBy = new Array<ScoredFinding | null>(truth.expected.length).fill(null);
  const score: FixtureScore = {
    fixture: truth.name,
    truePositives: 0,
    falsePositives: 0,
    falseNegatives: 0,
    duplicates: 0,
    acceptable: 0,
    outOfScope: 0,
    matched: [],
    missed: [],
    unexpected: [],
  };
  // Stable order, so which finding claims an issue does not depend on analyzer output order.
  for (const f of [...findings].sort(byPosition)) {
    if (!labeled.has(f.category)) {
      score.outOfScope++;
      continue;
    }
    const open = truth.expected.findIndex((e, i) => matchedBy[i] === null && locates(e, f));
    if (open >= 0) {
      matchedBy[open] = f;
      score.truePositives++;
      continue;
    }
    if (truth.expected.some((e) => locates(e, f))) score.duplicates++;
    else if (truth.acceptable.some((a) => locates(a, f))) score.acceptable++;
    else {
      score.falsePositives++;
      score.unexpected.push(f);
    }
  }
  truth.expected.forEach((e, i) => {
    const m = matchedBy[i];
    if (m) score.matched.push({ ruleId: m.ruleId, path: m.path, line: m.line });
    else {
      score.falseNegatives++;
      score.missed.push({ ruleId: e.ruleId, path: e.path ?? e.paths?.join(" | ") ?? null, lines: e.lines ?? null, why: e.why });
    }
  });
  return score;
}

export interface Rates {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** null when nothing was reported (0/0). */
  precision: number | null;
  /** null when nothing was expected (0/0). */
  recall: number | null;
  f1: number | null;
}

export function rates(tp: number, fp: number, fn: number): Rates {
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null;
  return { truePositives: tp, falsePositives: fp, falseNegatives: fn, precision: round(precision), recall: round(recall), f1: round(f1) };
}

const round = (x: number | null) => (x === null ? null : Math.round(x * 10_000) / 10_000);

/** Micro-averaged rates over all fixtures, and per rule. */
export function aggregate(scores: readonly FixtureScore[], ruleCategory: ReadonlyMap<string, string>) {
  const sum = (k: "truePositives" | "falsePositives" | "falseNegatives") => scores.reduce((n, s) => n + s[k], 0);
  const perRule = new Map<string, { tp: number; fp: number; fn: number }>();
  const bump = (rule: string, k: "tp" | "fp" | "fn") => {
    const r = perRule.get(rule) ?? { tp: 0, fp: 0, fn: 0 };
    r[k]++;
    perRule.set(rule, r);
  };
  for (const s of scores) {
    for (const m of s.matched) bump(m.ruleId, "tp");
    for (const u of s.unexpected) bump(u.ruleId, "fp");
    for (const m of s.missed) bump(m.ruleId, "fn");
  }
  const rules = [...perRule.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ruleId, r]) => ({ ruleId, category: ruleCategory.get(ruleId) ?? null, ...rates(r.tp, r.fp, r.fn) }));
  const perCategory = new Map<string, { tp: number; fp: number; fn: number }>();
  for (const r of rules) {
    const key = r.category ?? "UNKNOWN";
    const c = perCategory.get(key) ?? { tp: 0, fp: 0, fn: 0 };
    c.tp += r.truePositives;
    c.fp += r.falsePositives;
    c.fn += r.falseNegatives;
    perCategory.set(key, c);
  }
  return {
    overall: rates(sum("truePositives"), sum("falsePositives"), sum("falseNegatives")),
    categories: [...perCategory.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([category, c]) => ({ category, ...rates(c.tp, c.fp, c.fn) })),
    rules,
  };
}
