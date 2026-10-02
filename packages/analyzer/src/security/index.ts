import { readFile } from "node:fs/promises";
import type { Severity } from "@pd/shared/constants";
import { fingerprint, type CodeFinding, type TreeContext } from "../metrics";
import type { RepositoryScan } from "../scanner";
import { ANALYZER_VERSION } from "../version";
import { inspectTree } from "./patterns";
import { SECURITY_RULES, type SecurityRuleKey } from "./rules";
import { envFileFinding, scanTextForSecrets, SECRET_CONTEXTS, type SecretContext } from "./secrets";
import { severityRank, type RawSecurityFinding } from "./types";

export const SECURITY_ANALYZER_ID = "security";

export interface SecurityFinding extends Omit<CodeFinding, "category"> {
  category: "SECRET" | "SECURITY";
}

export interface SecuritySummary {
  analyzer: string;
  analyzerVersion: string;
  totals: {
    findings: number;
    secrets: number;
    insecurePatterns: number;
    /** Text files searched for secrets. */
    filesScanned: number;
    /** Production source files whose syntax trees were checked for insecure patterns. */
    sourceFilesInspected: number;
    filesWithFindings: number;
    bySeverity: Record<Severity, number>;
    /** Secret findings by where they were found (production source, configuration, tests, docs …). */
    secretsByContext: Record<SecretContext, number>;
  };
  /** Every rule that matched, most severe first, with its classification. */
  rules: Array<{
    id: string;
    type: string;
    category: "SECRET" | "SECURITY";
    title: string;
    cwe: string;
    owasp: string;
    count: number;
    maxSeverity: Severity;
  }>;
  topFiles: Array<{ path: string; findings: number; maxSeverity: Severity }>;
  /** Committed (non-template) environment files. */
  envFiles: string[];
  findings: { total: number; stored: number; truncated: boolean };
  /** Files that could not be read or inspected; analysis continued without them. */
  errors: number;
  durationMs: number;
}

export interface SecurityAnalysis {
  findings: SecurityFinding[];
  summary: SecuritySummary;
}

export interface SecurityScannerOptions {
  /** Upper bound on stored findings; the most severe are kept. */
  maxFindings?: number;
}

const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

/**
 * Security analysis in two parts:
 *  - `inspectTree` is passed to analyzeCode as its `onTree` hook, so insecure
 *    patterns are found on the same syntax trees as the code metrics (each
 *    file is parsed once). Only production source is inspected.
 *  - `finish` searches every text file for secrets and assembles the findings.
 */
export function createSecurityScanner(opts: SecurityScannerOptions = {}) {
  /** Time spent in security work only (tree inspection happens inside analyzeCode). */
  let busyMs = 0;
  const raw: Array<{ path: string; finding: RawSecurityFinding }> = [];
  let sourceFilesInspected = 0;
  let errors = 0;

  return {
    inspectTree(ctx: TreeContext): void {
      if (ctx.kind !== "SOURCE") return;
      sourceFilesInspected++;
      const t = performance.now();
      try {
        for (const finding of inspectTree(ctx.tree, ctx.grammar, ctx.source, ctx.path)) raw.push({ path: ctx.path, finding });
      } catch {
        errors++;
      }
      busyMs += performance.now() - t;
    },

    async finish(scan: Pick<RepositoryScan, "files" | "envFiles">): Promise<SecurityAnalysis> {
      const started = performance.now();
      const env = new Map(scan.envFiles.map((e) => [e.path, e.isTemplate]));
      let filesScanned = 0;
      for (const file of scan.files) {
        if (file.oversized || file.kind === "BINARY" || file.kind === "GENERATED") continue;
        let text: string;
        try {
          text = await readFile(file.absPath, "utf8");
        } catch {
          errors++;
          continue;
        }
        filesScanned++;
        const isEnvTemplate = env.get(file.path) === true;
        const isEnvFile = env.get(file.path) === false;
        for (const finding of scanTextForSecrets(text, { path: file.path, kind: file.kind, isEnvFile, isEnvTemplate })) {
          raw.push({ path: file.path, finding });
        }
        if (isEnvFile) {
          const f = envFileFinding(text, file.path);
          if (f) raw.push({ path: file.path, finding: f });
        }
        // Keep timers (queue lock renewal) running on large repositories.
        if (filesScanned % 200 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return build(raw, { filesScanned, sourceFilesInspected, errors, durationMs: busyMs + performance.now() - started, maxFindings: opts.maxFindings ?? 2000 });
    },
  };
}

export type SecurityScanner = ReturnType<typeof createSecurityScanner>;

function build(
  raw: Array<{ path: string; finding: RawSecurityFinding }>,
  ctx: { filesScanned: number; sourceFilesInspected: number; errors: number; durationMs: number; maxFindings: number },
): SecurityAnalysis {
  const ordinals = new Map<string, number>();
  const all: SecurityFinding[] = raw.map(({ path, finding }) => {
    const rule = SECURITY_RULES[finding.rule];
    const base = `${rule.id}\0${path}\0${finding.key}`;
    const ordinal = ordinals.get(base) ?? 0;
    ordinals.set(base, ordinal + 1);
    return {
      ruleId: rule.id,
      type: rule.type,
      category: rule.category,
      severity: finding.severity,
      title: rule.title,
      path,
      line: finding.line,
      endLine: finding.endLine,
      evidence: finding.evidence,
      impact: rule.impact,
      recommendation: rule.recommendation,
      fingerprint: fingerprint(rule.id, path, ordinal === 0 ? finding.key : `${finding.key}#${ordinal}`),
      analyzer: SECURITY_ANALYZER_ID,
      analyzerVersion: ANALYZER_VERSION,
      data: { cwe: rule.cwe, owasp: rule.owasp, ...finding.data },
    };
  });

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const secretsByContext = Object.fromEntries(SECRET_CONTEXTS.map((c) => [c, 0])) as Record<SecretContext, number>;
  for (const { finding } of raw) {
    const context = finding.data?.context as SecretContext | undefined;
    if (context && context in secretsByContext) secretsByContext[context]++;
  }
  const byRule = new Map<SecurityRuleKey, { count: number; maxSeverity: Severity }>();
  const byFile = new Map<string, { findings: number; maxSeverity: Severity }>();
  const worse = (a: Severity, b: Severity) => (severityRank(a) <= severityRank(b) ? a : b);
  raw.forEach(({ path, finding }) => {
    bySeverity[finding.severity]++;
    const r = byRule.get(finding.rule);
    byRule.set(finding.rule, r ? { count: r.count + 1, maxSeverity: worse(r.maxSeverity, finding.severity) } : { count: 1, maxSeverity: finding.severity });
    const f = byFile.get(path);
    byFile.set(path, f ? { findings: f.findings + 1, maxSeverity: worse(f.maxSeverity, finding.severity) } : { findings: 1, maxSeverity: finding.severity });
  });

  const stored = [...all]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.path.localeCompare(b.path) || a.line - b.line)
    .slice(0, ctx.maxFindings);
  const secrets = all.filter((f) => f.category === "SECRET").length;

  return {
    findings: stored,
    summary: {
      analyzer: SECURITY_ANALYZER_ID,
      analyzerVersion: ANALYZER_VERSION,
      totals: {
        findings: all.length,
        secrets,
        insecurePatterns: all.length - secrets,
        filesScanned: ctx.filesScanned,
        sourceFilesInspected: ctx.sourceFilesInspected,
        filesWithFindings: byFile.size,
        bySeverity,
        secretsByContext,
      },
      rules: [...byRule.entries()]
        .map(([key, r]) => {
          const d = SECURITY_RULES[key];
          return { id: d.id, type: d.type, category: d.category, title: d.title, cwe: d.cwe, owasp: d.owasp, ...r };
        })
        .sort((a, b) => severityRank(a.maxSeverity) - severityRank(b.maxSeverity) || b.count - a.count),
      topFiles: [...byFile.entries()]
        .map(([path, f]) => ({ path, ...f }))
        .sort((a, b) => severityRank(a.maxSeverity) - severityRank(b.maxSeverity) || b.findings - a.findings || a.path.localeCompare(b.path))
        .slice(0, 10),
      envFiles: raw.filter((r) => r.finding.rule === "committedEnvFile").map((r) => r.path),
      findings: { total: all.length, stored: stored.length, truncated: all.length > stored.length },
      errors: ctx.errors,
      durationMs: Math.round(ctx.durationMs),
    },
  };
}

export { SECURITY_RULES } from "./rules";
export { scanTextForSecrets, maskSecret, secretContextOf, SECRET_CONTEXTS, type SecretContext } from "./secrets";
export { inspectTree } from "./patterns";
