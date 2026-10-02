"use client";

import { Info, KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { formatNumber } from "@/lib/utils";
import { FindingsList } from "./findings-list";
import { CATEGORY_LABEL, SEVERITY_LABEL, SEVERITY_TONE } from "./labels";
import type { SecuritySummaryDto, SeverityDto } from "./types";

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "alert" }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "alert" ? "text-sev-critical" : ""}`}>{value}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function SeverityBadge({ severity }: { severity: SeverityDto }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Badge>;
}

export function SecurityPanel({ analysisId, security }: { analysisId: string; security: SecuritySummaryDto }) {
  const t = security.totals;
  const urgent = t.bySeverity.CRITICAL + t.bySeverity.HIGH;
  const secretRules = security.rules.filter((r) => r.category === "SECRET");
  // From analyzer v0.4.1 on, secrets in tests and docs are classified; older analyses treat all secrets alike.
  const fixtureSecrets = t.secretsByContext ? t.secretsByContext.test + t.secretsByContext.documentation : 0;
  const productionSecrets = t.secrets - fixtureSecrets;

  return (
    <div className="flex flex-col gap-6">
      {t.findings === 0 ? (
        <Card className="border-ok/30">
          <CardContent className="flex items-start gap-3 pt-5">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden />
            <div>
              <div className="font-medium">No secrets or insecure patterns detected</div>
              <p className="text-sm text-muted-foreground">
                {formatNumber(t.filesScanned)} files were searched for secrets and {formatNumber(t.sourceFilesInspected)} source files were
                checked against the insecure-pattern rules. This does not prove the code is secure; see the notes below.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : productionSecrets > 0 ? (
        <Card className="border-sev-critical/30">
          <CardContent className="flex items-start gap-3 pt-5">
            <KeyRound className="mt-0.5 size-5 shrink-0 text-sev-critical" aria-hidden />
            <div>
              <div className="font-medium">
                {formatNumber(productionSecrets)} possible {productionSecrets === 1 ? "secret" : "secrets"} committed to the repository
              </div>
              <p className="text-sm text-muted-foreground">
                Treat real credentials as compromised: revoke and rotate them first, then remove them from the code and from git history.
                Deleting them in a new commit does not revoke them.
                {fixtureSecrets > 0 &&
                  ` ${formatNumber(fixtureSecrets)} more ${fixtureSecrets === 1 ? "value was" : "values were"} found in tests or documentation and ${fixtureSecrets === 1 ? "looks" : "look"} like fixtures or examples.`}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        fixtureSecrets > 0 && (
          <Card>
            <CardContent className="flex items-start gap-3 pt-5">
              <Info className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
              <div>
                <div className="font-medium">
                  {formatNumber(fixtureSecrets)} secret-like {fixtureSecrets === 1 ? "value" : "values"} found only in tests or documentation
                </div>
                <p className="text-sm text-muted-foreground">
                  They look like test fixtures or documentation examples and are reported as Info. Confirm that none is a real credential:
                  a real key in a test file is still a leaked key.
                </p>
              </div>
            </CardContent>
          </Card>
        )
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Secrets"
          value={formatNumber(t.secrets)}
          hint={`${secretRules.length} ${secretRules.length === 1 ? "kind" : "kinds"}${fixtureSecrets > 0 ? ` · ${formatNumber(fixtureSecrets)} in tests/docs` : ""}`}
          tone={productionSecrets > 0 ? "alert" : undefined}
        />
        <Stat label="Critical + high" value={formatNumber(urgent)} hint={`${formatNumber(t.bySeverity.MEDIUM)} medium · ${formatNumber(t.bySeverity.LOW)} low`} />
        <Stat label="Insecure patterns" value={formatNumber(t.insecurePatterns)} hint={`in ${formatNumber(t.sourceFilesInspected)} source files checked`} />
        <Stat label="Files affected" value={formatNumber(t.filesWithFindings)} hint={`of ${formatNumber(t.filesScanned)} files scanned`} />
      </div>

      {security.rules.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardHeader>
              <CardTitle>What was found</CardTitle>
              <CardDescription>Each rule maps to a CWE weakness and an OWASP Top 10 category.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="pb-2 font-medium">Rule</th>
                      <th className="pb-2 font-medium">Weakness</th>
                      <th className="pb-2 text-right font-medium">Count</th>
                      <th className="pb-2 text-right font-medium">Worst</th>
                    </tr>
                  </thead>
                  <tbody>
                    {security.rules.map((r) => (
                      <tr key={r.id} className="border-t align-top">
                        <td className="py-1.5 pr-3">
                          <div className="font-medium">{r.title}</div>
                          <div className="text-xs text-muted-foreground">{CATEGORY_LABEL[r.category]}</div>
                        </td>
                        <td className="py-1.5 pr-3">
                          <div className="font-mono text-xs">{r.cwe}</div>
                          <div className="text-xs text-muted-foreground">{r.owasp}</div>
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{formatNumber(r.count)}</td>
                        <td className="py-1.5 text-right">
                          <SeverityBadge severity={r.maxSeverity} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Most affected files</CardTitle>
              <CardDescription>Ordered by worst severity, then number of findings.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="flex flex-col gap-2">
                {security.topFiles.map((f) => (
                  <li key={f.path} className="flex items-center gap-2 text-sm">
                    <SeverityBadge severity={f.maxSeverity} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={f.path}>
                      {f.path}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{formatNumber(f.findings)}</span>
                  </li>
                ))}
              </ul>
              {security.envFiles.length > 0 && (
                <p className="mt-4 flex items-start gap-2 rounded-md bg-sev-high/10 px-3 py-2 text-xs">
                  <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-sev-high" aria-hidden />
                  <span>
                    Committed environment {security.envFiles.length === 1 ? "file" : "files"}:{" "}
                    <span className="font-mono">{security.envFiles.join(", ")}</span>
                  </span>
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {t.findings > 0 && (
        <section aria-label="Security findings" className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">
            Security findings
            {security.findings.truncated && (
              <span className="ml-2 font-normal text-muted-foreground">
                (the {formatNumber(security.findings.stored)} most severe of {formatNumber(security.findings.total)} are stored)
              </span>
            )}
          </h2>
          <FindingsList analysisId={analysisId} categories="SECRET,SECURITY" emptyMessage="No security findings." />
        </section>
      )}

      <div className="flex items-start gap-3 rounded-lg border px-4 py-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <div className="flex flex-col gap-1">
          <p>
            Secret values are never stored or displayed: evidence shows the surrounding code with the value masked. Matches in test and
            documentation files are reported one severity lower because they are often fixtures or examples.
          </p>
          <p>
            Insecure-pattern rules match the syntax of dangerous calls in production source (JavaScript, TypeScript, Python, Java, C, C++).
            They do not track data flow, so a flagged call may be safe if its input is trusted, and vulnerabilities outside these patterns are
            not detected. Measured by {security.analyzer} v{security.analyzerVersion} in {formatNumber(security.durationMs)} ms
            {security.errors > 0 && `; ${formatNumber(security.errors)} files could not be inspected`}.
          </p>
        </div>
      </div>
    </div>
  );
}
