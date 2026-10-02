import type { FindingCategory, Severity } from "@pd/shared/constants";

/**
 * Explainable health score. Each dimension starts at 100 and loses points for
 * the findings in its categories (and for measured duplication), and every
 * deduction is listed with the reason. The overall score is the weighted mean
 * of the dimensions that apply to the repository, capped while severe security
 * findings are open (SCORE_CAPS). Weights, penalties and caps
 * are stored with every analysis (`Analysis.weightsUsed`), so a score can be
 * recomputed and explained later.
 *
 * Scores are heuristics: they summarise what the deterministic analyzers found,
 * and cannot account for problems those analyzers cannot see.
 */

/** Bumped whenever weights, penalties or the formula change. */
export const SCORING_VERSION = "1.0";

export const SCORE_DIMENSIONS = [
  { id: "security", label: "Security", weight: 25, categories: ["SECRET", "SECURITY"], perKloc: false },
  { id: "codeQuality", label: "Code quality", weight: 15, categories: ["CODE_QUALITY"], perKloc: true },
  { id: "dependencies", label: "Dependencies", weight: 15, categories: ["DEPENDENCY"], perKloc: false },
  { id: "testing", label: "Testing", weight: 15, categories: ["TESTING"], perKloc: false },
  { id: "architecture", label: "Architecture", weight: 10, categories: ["ARCHITECTURE"], perKloc: true },
  { id: "documentation", label: "Documentation", weight: 10, categories: ["DOCUMENTATION"], perKloc: false },
  { id: "api", label: "API", weight: 5, categories: ["API"], perKloc: false },
  { id: "database", label: "Database", weight: 5, categories: ["DATABASE"], perKloc: false },
] as const satisfies ReadonlyArray<{ id: string; label: string; weight: number; categories: readonly FindingCategory[]; perKloc: boolean }>;

export type ScoreDimensionId = (typeof SCORE_DIMENSIONS)[number]["id"];

/** Points per finding, and the most one severity can cost a dimension. */
export const SEVERITY_PENALTY: Record<Severity, number> = { CRITICAL: 30, HIGH: 15, MEDIUM: 6, LOW: 2, INFO: 0 };
export const SEVERITY_CAP: Record<Severity, number> = { CRITICAL: 60, HIGH: 45, MEDIUM: 30, LOW: 15, INFO: 0 };
/** Findings whose absence of something matters more than their severity suggests: a fixed penalty, outside the caps. */
export const RULE_PENALTY: Record<string, number> = {
  "testing/no-tests": 80,
  "documentation/missing-readme": 40,
};
/**
 * Weakest-link caps: a weighted mean would let good documentation and tests hide an
 * exploitable vulnerability, so untriaged security or secret findings of these
 * severities limit the overall score. The first matching cap applies.
 */
export const SCORE_CAPS = [
  { severity: "CRITICAL", categories: ["SECRET", "SECURITY"], max: 49 },
  { severity: "HIGH", categories: ["SECRET", "SECURITY"], max: 69 },
] as const satisfies ReadonlyArray<{ severity: Severity; categories: readonly FindingCategory[]; max: number }>;
/** Duplicated production code above `threshold` percent costs one point per percent, at most `max`. */
export const DUPLICATION = { threshold: 5, max: 15 } as const;
export const GRADES = [
  { grade: "A", min: 90 },
  { grade: "B", min: 75 },
  { grade: "C", min: 60 },
  { grade: "D", min: 40 },
  { grade: "F", min: 0 },
] as const;
export type Grade = (typeof GRADES)[number]["grade"];

const SEVERITY_ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

export interface ScoreFactor {
  /** What was counted, e.g. "2 high findings". */
  label: string;
  /** Points deducted (negative), one decimal. */
  points: number;
  /** How the points were computed. */
  detail: string;
}

export interface DimensionScore {
  id: ScoreDimensionId;
  label: string;
  weight: number;
  applicable: boolean;
  /** 0–100, or null when the dimension does not apply. */
  score: number | null;
  /** Share of the overall score after leaving out dimensions that do not apply, in percent. */
  effectiveWeight: number;
  factors: ScoreFactor[];
  /** Findings that counted towards this dimension. */
  findings: number;
  /** Findings left out because they were triaged as Expected or Ignored. */
  excluded: number;
  /** Why the dimension does not apply. */
  note: string | null;
}

export interface HealthScore {
  version: string;
  score: number;
  grade: Grade;
  /** Weighted mean of the applicable dimensions, before any cap. */
  weightedScore: number;
  /** Set when severe security findings limited the score. */
  cap: { max: number; reason: string } | null;
  dimensions: DimensionScore[];
  /** Limits of this score (unchecked vulnerabilities, no coverage data, excluded findings …). */
  caveats: string[];
  excludedFindings: number;
}

export interface ScoringInput {
  findings: ReadonlyArray<{ ruleId: string; category: FindingCategory; severity: Severity; fingerprint: string; title?: string }>;
  /** Fingerprints of findings triaged as Expected or Ignored; they do not count. */
  excludedFingerprints?: ReadonlySet<string>;
  /** Production code lines, for the dimensions measured per 1,000 lines. */
  productionCodeLines: number;
  duplicationPercent?: number | null;
  /** What exists to be scored; a dimension without a subject is left out instead of scoring 100. */
  present: { code: boolean; dependencies: boolean; architecture: boolean; api: boolean; database: boolean };
  vulnerabilityScan?: { status: string; notChecked: number } | null;
  coverageMeasured?: boolean;
}

/** The parameters a score was computed with; stored as `Analysis.weightsUsed`. */
export function scoringWeights() {
  return {
    version: SCORING_VERSION,
    dimensions: Object.fromEntries(SCORE_DIMENSIONS.map((d) => [d.id, { weight: d.weight, categories: d.categories, perKloc: d.perKloc }])),
    severityPenalty: SEVERITY_PENALTY,
    severityCap: SEVERITY_CAP,
    rulePenalty: RULE_PENALTY,
    duplication: DUPLICATION,
    caps: SCORE_CAPS,
    grades: GRADES,
  };
}

export function gradeFor(score: number): Grade {
  return GRADES.find((g) => score >= g.min)!.grade;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const fmt = (n: number) => n.toLocaleString("en", { maximumFractionDigits: 1 });
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

function applicability(id: ScoreDimensionId, present: ScoringInput["present"], hasFindings: boolean): string | null {
  if (hasFindings) return null;
  switch (id) {
    case "codeQuality":
    case "testing":
      return present.code ? null : "No production source code in a supported language.";
    case "dependencies":
      return present.dependencies ? null : "No dependency manifests were found.";
    case "architecture":
      return present.architecture ? null : "No production source files to build an import graph from.";
    case "api":
      return present.api ? null : "No HTTP endpoints were detected.";
    case "database":
      return present.database ? null : "No database, ORM or schema was detected.";
    default:
      return null;
  }
}

export function computeHealthScore(input: ScoringInput): HealthScore {
  const excludedSet = input.excludedFingerprints ?? new Set<string>();
  const kloc = Math.max(1, input.productionCodeLines / 1000);
  let excludedFindings = 0;

  const dimensions: DimensionScore[] = SCORE_DIMENSIONS.map((d) => {
    const inDimension = input.findings.filter((f) => (d.categories as readonly string[]).includes(f.category));
    const counted = inDimension.filter((f) => !excludedSet.has(f.fingerprint));
    const excluded = inDimension.length - counted.length;
    excludedFindings += excluded;
    const note = applicability(d.id, input.present, inDimension.length > 0);
    const factors: ScoreFactor[] = [];

    if (!note) {
      // Fixed penalties for specific rules.
      const fixed = new Map<string, { n: number; title: string }>();
      for (const f of counted) {
        if (RULE_PENALTY[f.ruleId] === undefined) continue;
        const entry = fixed.get(f.ruleId) ?? { n: 0, title: f.title ?? f.ruleId };
        entry.n++;
        fixed.set(f.ruleId, entry);
      }
      for (const [ruleId, { n, title }] of fixed) {
        factors.push({ label: `${title}${n > 1 ? ` × ${n}` : ""}`, points: -RULE_PENALTY[ruleId]! * n, detail: `Fixed penalty of ${RULE_PENALTY[ruleId]} points (${ruleId}).` });
      }
      // Severity penalties, capped per severity; per 1,000 lines of code where findings grow with size.
      for (const severity of SEVERITY_ORDER) {
        const n = counted.filter((f) => f.severity === severity && RULE_PENALTY[f.ruleId] === undefined).length;
        if (n === 0 || SEVERITY_PENALTY[severity] === 0) continue;
        const rawPoints = d.perKloc ? (SEVERITY_PENALTY[severity] * n) / kloc : SEVERITY_PENALTY[severity] * n;
        const points = Math.min(SEVERITY_CAP[severity], rawPoints);
        factors.push({
          label: `${plural(n, `${severity.toLowerCase()} finding`)}${d.perKloc ? ` in ${fmt(input.productionCodeLines / 1000)}k lines` : ""}`,
          points: -round1(points),
          detail: d.perKloc
            ? `${SEVERITY_PENALTY[severity]} points per finding per 1,000 lines of production code, at most ${SEVERITY_CAP[severity]}.`
            : `${SEVERITY_PENALTY[severity]} points each, at most ${SEVERITY_CAP[severity]}.`,
        });
      }
      if (d.id === "codeQuality" && input.duplicationPercent != null && input.duplicationPercent > DUPLICATION.threshold) {
        factors.push({
          label: `${fmt(input.duplicationPercent)}% duplicated code`,
          points: -round1(Math.min(DUPLICATION.max, input.duplicationPercent - DUPLICATION.threshold)),
          detail: `1 point per percent above ${DUPLICATION.threshold}%, at most ${DUPLICATION.max}.`,
        });
      }
    }
    const deducted = Math.min(100, -factors.reduce((n, f) => n + f.points, 0));
    return {
      id: d.id,
      label: d.label,
      weight: d.weight,
      applicable: !note,
      score: note ? null : Math.max(0, Math.round(100 - deducted)),
      effectiveWeight: 0,
      factors: factors.sort((a, b) => a.points - b.points),
      findings: counted.length,
      excluded,
      note,
    };
  });

  const applicable = dimensions.filter((d) => d.applicable);
  const totalWeight = applicable.reduce((n, d) => n + d.weight, 0);
  for (const d of applicable) d.effectiveWeight = round1((d.weight / totalWeight) * 100);
  const weightedScore = Math.round(applicable.reduce((n, d) => n + d.weight * d.score!, 0) / totalWeight);
  let cap: HealthScore["cap"] = null;
  for (const c of SCORE_CAPS) {
    const n = input.findings.filter(
      (f) => f.severity === c.severity && (c.categories as readonly string[]).includes(f.category) && !excludedSet.has(f.fingerprint),
    ).length;
    if (n === 0) continue;
    cap = { max: c.max, reason: `${plural(n, `${c.severity.toLowerCase()} security finding`)} (secrets or insecure code) limit the score to ${c.max} until fixed or triaged.` };
    break;
  }
  const score = cap ? Math.min(weightedScore, cap.max) : weightedScore;

  const caveats: string[] = [];
  const scan = input.vulnerabilityScan;
  if (input.present.dependencies && scan) {
    if (scan.status === "disabled") caveats.push("The vulnerability lookup is disabled (OSV_ENABLED=false), so known vulnerabilities do not affect the dependency score.");
    else if (scan.status === "failed") caveats.push("The vulnerability lookup failed, so known vulnerabilities do not affect the dependency score.");
    else if (scan.status === "partial") caveats.push("The vulnerability lookup was incomplete; the dependency score may miss known vulnerabilities.");
    else if (scan.status === "skipped") caveats.push("No dependency had an exact version to check, so known vulnerabilities could not be looked up.");
    else if (scan.notChecked > 0) caveats.push(`${plural(scan.notChecked, "dependency", "dependencies")} could not be checked for known vulnerabilities (no exact version, non-registry source or private registry).`);
  }
  if (input.present.code && !input.coverageMeasured) caveats.push("No coverage report was found, so the testing score reflects how much test code exists, not how much code the tests execute.");
  if (excludedFindings > 0) caveats.push(`${plural(excludedFindings, "finding")} triaged as Expected or Ignored ${excludedFindings === 1 ? "was" : "were"} not counted.`);

  return { version: SCORING_VERSION, score, grade: gradeFor(score), weightedScore, cap, dimensions, caveats, excludedFindings };
}
