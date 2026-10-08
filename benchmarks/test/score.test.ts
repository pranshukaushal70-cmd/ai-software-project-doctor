import { describe, expect, it } from "vitest";
import { GroundTruthSchema, type GroundTruth } from "../src/ground-truth";
import { aggregate, rates, scoreFixture, type ScoredFinding } from "../src/score";

const truth = (over: Partial<GroundTruth> = {}): GroundTruth =>
  GroundTruthSchema.parse({
    name: "t",
    description: "test fixture",
    source: { dir: "repo" },
    labeledCategories: ["SECURITY", "ARCHITECTURE"],
    expected: [
      { ruleId: "injection/sql", path: "db.js", lines: [7, 9], why: "concatenated query" },
      { ruleId: "architecture/circular-dependency", paths: ["a.js", "b.js"], why: "cycle" },
    ],
    acceptable: [{ ruleId: "crypto/weak-hash", path: "legacy.js", why: "documented legacy checksum" }],
    tasks: [],
    ...over,
  });

const f = (ruleId: string, path: string | null, line: number | null, category = "SECURITY"): ScoredFinding => ({ ruleId, category, path, line });

describe("scoreFixture", () => {
  it("matches rule, file and line span", () => {
    const s = scoreFixture(truth(), [f("injection/sql", "db.js", 8), f("architecture/circular-dependency", "b.js", null, "ARCHITECTURE")]);
    expect(s).toMatchObject({ truePositives: 2, falsePositives: 0, falseNegatives: 0 });
  });

  it("counts a finding outside the span, in another file or of another rule as a false positive and the issue as missed", () => {
    const s = scoreFixture(truth(), [f("injection/sql", "db.js", 20), f("injection/sql", "other.js", 8), f("injection/os-command", "db.js", 8)]);
    expect(s).toMatchObject({ truePositives: 0, falsePositives: 3, falseNegatives: 2 });
    expect(s.missed.map((m) => m.path)).toEqual(["db.js", "a.js | b.js"]);
  });

  it("matches each issue once; further findings of the same issue are duplicates", () => {
    const s = scoreFixture(truth(), [
      f("architecture/circular-dependency", "a.js", null, "ARCHITECTURE"),
      f("architecture/circular-dependency", "b.js", null, "ARCHITECTURE"),
    ]);
    expect(s).toMatchObject({ truePositives: 1, duplicates: 1, falsePositives: 0, falseNegatives: 1 });
  });

  it("does not count acceptable findings or findings outside the labelled categories", () => {
    const s = scoreFixture(truth(), [f("crypto/weak-hash", "legacy.js", 3), f("documentation/missing-license", null, null, "DOCUMENTATION")]);
    expect(s).toMatchObject({ truePositives: 0, falsePositives: 0, acceptable: 1, outOfScope: 1 });
  });

  it("does not depend on the order findings arrive in", () => {
    const findings = [f("injection/sql", "db.js", 9), f("injection/sql", "db.js", 7)];
    expect(scoreFixture(truth(), findings)).toEqual(scoreFixture(truth(), [...findings].reverse()));
  });

  it("treats every finding as a false positive in a clean fixture", () => {
    const clean = truth({ expected: [], acceptable: [] });
    expect(scoreFixture(clean, [f("injection/sql", "db.js", 8)])).toMatchObject({ truePositives: 0, falsePositives: 1, falseNegatives: 0 });
  });
});

describe("rates", () => {
  it("computes precision, recall and F1, and n/a for empty denominators", () => {
    expect(rates(3, 1, 1)).toEqual({ truePositives: 3, falsePositives: 1, falseNegatives: 1, precision: 0.75, recall: 0.75, f1: 0.75 });
    expect(rates(0, 0, 0)).toMatchObject({ precision: null, recall: null, f1: null });
    expect(rates(0, 2, 0)).toMatchObject({ precision: 0, recall: null });
  });

  it("aggregates per rule and per category", () => {
    const s = scoreFixture(truth(), [f("injection/sql", "db.js", 8), f("injection/sql", "x.js", 1)]);
    const agg = aggregate([s], new Map([["injection/sql", "SECURITY"], ["architecture/circular-dependency", "ARCHITECTURE"]]));
    expect(agg.overall).toMatchObject({ truePositives: 1, falsePositives: 1, falseNegatives: 1 });
    expect(agg.rules.find((r) => r.ruleId === "injection/sql")).toMatchObject({ truePositives: 1, falsePositives: 1, precision: 0.5 });
    expect(agg.categories.map((c) => c.category)).toEqual(["ARCHITECTURE", "SECURITY"]);
  });
});

describe("ground-truth schema", () => {
  it("rejects unknown keys and malformed names", () => {
    expect(() => truth({ name: "Bad Name" })).toThrow();
    expect(() => GroundTruthSchema.parse({ ...truth(), extra: 1 })).toThrow();
  });
});
