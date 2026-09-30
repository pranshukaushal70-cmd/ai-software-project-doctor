import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SecurityPanel } from "@/components/analysis/security-panel";
import type { SecuritySummaryDto } from "@/components/analysis/types";

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
});
