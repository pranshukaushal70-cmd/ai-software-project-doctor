import type { Severity } from "@pd/shared/constants";
import type { SecurityRuleKey } from "./rules";

/** A security finding before it is attached to a path and fingerprinted. */
export interface RawSecurityFinding {
  rule: SecurityRuleKey;
  severity: Severity;
  line: number;
  endLine: number;
  /** Human-readable evidence. Never contains a secret value: secrets are masked before this is built. */
  evidence: string;
  /** Stable identity within the file; never derived from a secret value. */
  key: string;
  data?: Record<string, unknown>;
}

const ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

/** One step less severe (CRITICAL → HIGH …), used for matches in tests and documentation. */
export function downgrade(severity: Severity): Severity {
  return ORDER[Math.min(ORDER.indexOf(severity) + 1, ORDER.length - 2)]!;
}

export function severityRank(severity: Severity): number {
  return ORDER.indexOf(severity);
}
