import type { Severity } from "@pd/shared/constants";

const W = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
} as const;

/** CVSS v3.1 Roundup: smallest one-decimal number ≥ x, robust to floating-point error. */
function roundUp(x: number): number {
  const i = Math.round(x * 100_000);
  return i % 10_000 === 0 ? i / 100_000 : (Math.floor(i / 10_000) + 1) / 10;
}

/**
 * CVSS v3.0/v3.1 base score from a vector such as
 * `CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H` (→ 9.8). Returns null for
 * other versions or malformed vectors.
 */
export function cvss3BaseScore(vector: string): number | null {
  const m = /^CVSS:3\.[01]\/(.+)$/.exec(vector.trim());
  if (!m) return null;
  const metrics = new Map(m[1]!.split("/").map((part) => part.split(":") as [string, string]));
  const get = <T extends Record<string, number>>(key: string, table: T): number | null => {
    const v = metrics.get(key);
    return v !== undefined && v in table ? table[v as keyof T]! : null;
  };
  const scope = metrics.get("S");
  if (scope !== "U" && scope !== "C") return null;
  const changed = scope === "C";
  const av = get("AV", W.AV);
  const ac = get("AC", W.AC);
  const ui = get("UI", W.UI);
  const pr = get("PR", changed ? { N: 0.85, L: 0.68, H: 0.5 } : { N: 0.85, L: 0.62, H: 0.27 });
  const c = get("C", W.CIA);
  const i = get("I", W.CIA);
  const a = get("A", W.CIA);
  if ([av, ac, ui, pr, c, i, a].some((v) => v === null)) return null;

  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av! * ac! * pr! * ui!;
  return roundUp(Math.min(changed ? 1.08 * (impact + exploitability) : impact + exploitability, 10));
}

/** Qualitative rating from the CVSS specification (0 → INFO). */
export function cvssSeverity(score: number): Severity {
  if (score >= 9) return "CRITICAL";
  if (score >= 7) return "HIGH";
  if (score >= 4) return "MEDIUM";
  if (score > 0) return "LOW";
  return "INFO";
}
