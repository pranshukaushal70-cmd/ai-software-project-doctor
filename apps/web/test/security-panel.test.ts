import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FindingRow } from "@/components/analysis/findings-list";
import { SecurityPanel } from "@/components/analysis/security-panel";
import type { FindingDto, SecuritySummaryDto } from "@/components/analysis/types";

const base: SecuritySummaryDto = {
  analyzer: "security",
  analyzerVersion: "0.3.0",
  totals: {
    findings: 0,
    secrets: 0,
    insecurePatterns: 0,
    filesScanned: 120,
    sourceFilesInspected: 80,
    filesWithFindings: 0,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 },
  },
  rules: [],
  topFiles: [],
  envFiles: [],
  findings: { total: 0, stored: 0, truncated: false },
  errors: 0,
  durationMs: 42,
};

const render = (security: SecuritySummaryDto) => renderToStaticMarkup(createElement(SecurityPanel, { analysisId: "a1", security }));

describe("SecurityPanel", () => {
  it("renders a clean result without claiming the code is secure", () => {
    const html = render(base);
    expect(html).toContain("No secrets or insecure patterns detected");
    expect(html).toContain("does not prove the code is secure");
    expect(html).not.toContain("Security findings");
  });

  it("renders secrets, rules with CWE/OWASP, affected files and env files", () => {
    const html = render({
      ...base,
      totals: {
        ...base.totals,
        findings: 3,
        secrets: 2,
        insecurePatterns: 1,
        filesWithFindings: 2,
        bySeverity: { CRITICAL: 1, HIGH: 1, MEDIUM: 1, LOW: 0, INFO: 0 },
      },
      rules: [
        { id: "secret/api-token", type: "api-token", category: "SECRET", title: "API token or key for a third-party service", cwe: "CWE-798", owasp: "A07:2021 Identification and Authentication Failures", count: 1, maxSeverity: "CRITICAL" },
        { id: "injection/sql", type: "sql-injection", category: "SECURITY", title: "SQL query built by string concatenation or interpolation", cwe: "CWE-89", owasp: "A03:2021 Injection", count: 1, maxSeverity: "HIGH" },
      ],
      topFiles: [{ path: "src/config.ts", findings: 2, maxSeverity: "CRITICAL" }],
      envFiles: [".env"],
      findings: { total: 3, stored: 3, truncated: false },
    });
    expect(html).toContain("2 possible secrets committed to the repository");
    expect(html).toContain("CWE-89");
    expect(html).toContain("A03:2021 Injection");
    expect(html).toContain("src/config.ts");
    expect(html).toContain("Committed environment file");
    expect(html).toContain("Security findings");
  });

  const secretsOnly = (secretsByContext: NonNullable<SecuritySummaryDto["totals"]["secretsByContext"]>): SecuritySummaryDto => {
    const secrets = Object.values(secretsByContext).reduce((n, v) => n + v, 0);
    return {
      ...base,
      totals: { ...base.totals, findings: secrets, secrets, filesWithFindings: 1, bySeverity: { ...base.totals.bySeverity, INFO: secrets }, secretsByContext },
      findings: { total: secrets, stored: secrets, truncated: false },
    };
  };

  it("does not raise the rotate-now alert when every secret is a test fixture or docs example", () => {
    const html = render(secretsOnly({ source: 0, configuration: 0, template: 0, test: 18, documentation: 2 }));
    expect(html).toContain("20 secret-like values found only in tests or documentation");
    expect(html).toContain("a real key in a test file is still a leaked key");
    expect(html).not.toContain("committed to the repository");
    expect(html).toContain("20 in tests/docs");
  });

  it("alerts only on secrets outside tests and docs, and mentions the rest", () => {
    const html = render(secretsOnly({ source: 1, configuration: 1, template: 0, test: 3, documentation: 0 }));
    expect(html).toContain("2 possible secrets committed to the repository");
    expect(html).toContain("3 more values were found in tests or documentation");
  });

  it("keeps the previous behaviour for analyses made before secrets were classified", () => {
    const html = render({ ...base, totals: { ...base.totals, findings: 2, secrets: 2, filesWithFindings: 1 }, findings: { total: 2, stored: 2, truncated: false } });
    expect(html).toContain("2 possible secrets committed to the repository");
  });
});

describe("FindingRow", () => {
  const finding = (data: Record<string, unknown> | null): FindingDto => ({
    id: "f1",
    category: "SECRET",
    type: "hardcoded-credential",
    severity: "INFO",
    ruleId: "secret/hardcoded-credential",
    title: "Hard-coded password or secret",
    path: "test/security.test.ts",
    language: "typescript",
    line: 3,
    endLine: 3,
    evidence: "Value assigned to `password` at line 3 (detected in a security test fixture; likely intentional).",
    impact: "…",
    recommendation: "…",
    fingerprint: "abc123def456abc1",
    data,
    analyzer: "security",
    analyzerVersion: "0.4.1",
  });
  const row = (data: Record<string, unknown> | null) => renderToStaticMarkup(createElement(FindingRow, { finding: finding(data) }));

  it("labels secrets found in tests and docs, and intentional fixtures", () => {
    expect(row({ context: "test", likelyIntentional: true })).toContain(">Test fixture<");
    expect(row({ context: "test", likelyIntentional: true })).toContain(">Likely intentional<");
    expect(row({ context: "documentation", likelyIntentional: true })).toContain(">Docs example<");
  });

  it("shows a finding's triage decision as a badge, keeping the finding listed", () => {
    const triaged = (status: "EXPECTED" | "IGNORED") =>
      renderToStaticMarkup(createElement(FindingRow, { finding: { ...finding(null), triage: { status, reason: "fake key", updatedAt: "2026-10-02T12:00:00Z" } }, analysisId: "a1" }));
    expect(triaged("EXPECTED")).toContain(">Expected<");
    expect(triaged("IGNORED")).toContain(">Ignored<");
    expect(triaged("IGNORED")).toContain("Hard-coded password or secret");
    expect(row(null)).not.toMatch(/>(?:Expected|Ignored)</);
  });

  it("adds no context badge for production findings or findings without context", () => {
    for (const data of [{ context: "source", likelyIntentional: false }, { context: "configuration", likelyIntentional: false }, null]) {
      const html = row(data);
      expect(html).not.toMatch(/>(?:Test fixture|Docs example|Template|Likely intentional)</);
    }
  });
});
