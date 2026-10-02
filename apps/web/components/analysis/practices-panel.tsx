import { Check, Info, X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { formatNumber } from "@/lib/utils";
import { FindingsList } from "./findings-list";
import { Stat } from "./stat";
import type { PracticesSummaryDto } from "./types";

const MAX_ENDPOINTS_SHOWN = 50;

function CheckItem({ ok, label, detail }: { ok: boolean; label: string; detail?: string | null }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? <Check className="mt-0.5 size-4 shrink-0 text-ok" aria-label="yes" /> : <X className="mt-0.5 size-4 shrink-0 text-sev-high" aria-label="no" />}
      <span>
        {label}
        {detail && <span className="ml-2 break-all font-mono text-xs text-muted-foreground">{detail}</span>}
      </span>
    </li>
  );
}

function ApiSection({ api }: { api: PracticesSummaryDto["api"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>API</CardTitle>
        <CardDescription>
          {api.endpoints === 0
            ? "No HTTP endpoints were detected (Express, Fastify, Koa, Hono, NestJS, Next.js, Flask, FastAPI, Django and Spring are recognised)."
            : `${formatNumber(api.endpoints)} endpoints in ${api.frameworks.map((f) => f.name).join(", ")}, found from their declarations.`}
        </CardDescription>
      </CardHeader>
      {api.endpoints > 0 && (
        <CardContent className="flex flex-col gap-4">
          <ul className="flex flex-col gap-1.5">
            <CheckItem ok={api.mutatingWithoutAuth === 0} label={`${api.mutating - api.mutatingWithoutAuth} of ${api.mutating} state-changing endpoints show an authentication check`} detail={api.globalAuth} />
            <CheckItem ok={api.bodyWithoutValidation === 0} label={api.bodyWithoutValidation === 0 ? "Request bodies are validated where they are read" : `${api.bodyWithoutValidation} endpoints read the body without visible validation`} />
            <CheckItem ok={!!api.rateLimiting} label="Rate limiting configured" detail={api.rateLimiting} />
            <CheckItem ok={api.specFiles.length > 0 || !!api.specTooling} label="API specification" detail={api.specFiles[0] ?? api.specTooling} />
          </ul>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Method</th>
                  <th className="pb-2 font-medium">Path</th>
                  <th className="pb-2 font-medium">Declared in</th>
                  <th className="pb-2 font-medium">Auth</th>
                </tr>
              </thead>
              <tbody>
                {api.list.slice(0, MAX_ENDPOINTS_SHOWN).map((e) => (
                  <tr key={`${e.method} ${e.path} ${e.file}`} className="border-t align-top">
                    <td className="py-1.5 pr-3 font-mono text-xs">{e.method}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs break-all">{e.path}</td>
                    <td className="py-1.5 pr-3 font-mono text-xs text-muted-foreground break-all">
                      {e.file}:{e.line}
                    </td>
                    <td className="py-1.5">{e.auth ? <Badge tone="ok">seen</Badge> : <Badge tone="neutral">not seen</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(api.list.length > MAX_ENDPOINTS_SHOWN || api.listTruncated) && (
            <p className="text-xs text-muted-foreground">
              Showing {MAX_ENDPOINTS_SHOWN} of {formatNumber(api.endpoints)} endpoints.
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function DatabaseSection({ db }: { db: PracticesSummaryDto["database"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Database</CardTitle>
        <CardDescription>
          {db.detected ? "Schema files, ORM models and migrations, read as text. No database is contacted." : "No database, ORM or schema was detected."}
        </CardDescription>
      </CardHeader>
      {db.detected && (
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-3 gap-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Models</div>
              <div className="text-lg font-semibold tabular-nums">{formatNumber(db.models)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">SQL tables</div>
              <div className="text-lg font-semibold tabular-nums">{formatNumber(db.tables)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Relations</div>
              <div className="text-lg font-semibold tabular-nums">{formatNumber(db.relations)}</div>
            </div>
          </div>
          <ul className="flex flex-col gap-1.5">
            <CheckItem ok={db.migrations.files > 0} label={db.migrations.files > 0 ? `${db.migrations.files} migration files` : "Versioned migrations"} detail={db.migrations.tools.join(", ") || null} />
            <CheckItem ok={db.unindexedForeignKeys === 0} label={db.unindexedForeignKeys === 0 ? "Foreign keys are indexed" : `${db.unindexedForeignKeys} foreign keys without an index`} />
            <CheckItem ok={db.tablesWithoutPrimaryKey === 0} label={db.tablesWithoutPrimaryKey === 0 ? "Every SQL table has a primary key" : `${db.tablesWithoutPrimaryKey} tables without a primary key`} />
            <CheckItem ok={db.autoSchemaSync.length === 0} label="Schema is not changed automatically at start-up" detail={db.autoSchemaSync[0]} />
          </ul>
          {db.technologies.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Detected: {db.technologies.map((t) => t.name).join(", ")}
            </p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function TestingSection({ t }: { t: PracticesSummaryDto["testing"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Testing</CardTitle>
        <CardDescription>Measured from the test files; coverage is shown only when a committed report exists, never estimated.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex flex-col gap-1.5">
          <CheckItem ok={t.testFiles > 0} label={`${formatNumber(t.testFiles)} test files, ${formatNumber(t.testCases)} test cases`} detail={t.frameworks.map((f) => f.name).join(", ") || null} />
          <CheckItem
            ok={t.testRatio !== null && t.testRatio >= 0.2}
            label={t.testRatio === null ? "No production code to compare with" : `Test-to-code ratio ${t.testRatio}`}
            detail={`${formatNumber(t.testCodeLines)} / ${formatNumber(t.sourceCodeLines)} lines`}
          />
          <CheckItem
            ok={!!t.coverage && t.coverage.linePercent >= 70}
            label={t.coverage ? `${t.coverage.linePercent}% line coverage (${t.coverage.format})` : "No committed coverage report"}
            detail={t.coverage?.path}
          />
          <CheckItem ok={t.ci.runsTests} label={t.ci.runsTests ? "CI runs the tests" : t.ci.configured ? "CI does not run the tests" : "No CI configuration"} detail={t.ci.evidence} />
          {(t.focused > 0 || t.skipped > 0) && <CheckItem ok={t.focused === 0} label={`${t.focused} focused and ${t.skipped} skipped tests`} />}
        </ul>
        {t.untested.length > 0 && (
          <div>
            <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Largest files no test refers to</div>
            <ul className="flex flex-col gap-1 text-sm">
              {t.untested.slice(0, 8).map((f) => (
                <li key={f.path} className="flex justify-between gap-3">
                  <span className="truncate font-mono text-xs" title={f.path}>
                    {f.path}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{formatNumber(f.codeLines)} lines</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DocumentationSection({ d }: { d: PracticesSummaryDto["documentation"] }) {
  const s = d.readme?.sections;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Documentation</CardTitle>
        <CardDescription>Whether a newcomer can install, configure and run the project from its documentation.</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-1.5">
          <CheckItem ok={!!d.readme} label={d.readme ? `README (${formatNumber(d.readme.words)} words)` : "README"} detail={d.readme?.path} />
          {s && <CheckItem ok={s.installation && s.usage} label={`README explains ${[s.installation && "installation", s.usage && "usage", s.configuration && "configuration", s.testing && "testing"].filter(Boolean).join(", ") || "none of installation, usage, configuration or testing"}`} />}
          <CheckItem ok={!!d.license} label="License file" detail={d.license ?? d.licenseDeclared} />
          <CheckItem
            ok={d.envVars.undocumented.length === 0}
            label={`${d.envVars.documented} of ${d.envVars.used} environment variables documented`}
            detail={d.envVars.undocumented.slice(0, 6).join(", ") || null}
          />
          <CheckItem ok={d.links.broken === 0} label={`${d.links.checked - d.links.broken} of ${d.links.checked} relative links resolve`} />
          <CheckItem ok={!!d.contributing} label="Contribution guide" detail={d.contributing} />
        </ul>
      </CardContent>
    </Card>
  );
}

export function PracticesPanel({ analysisId, summary }: { analysisId: string; summary: PracticesSummaryDto }) {
  const f = summary.findings;
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Endpoints" value={formatNumber(summary.api.endpoints)} hint={`${formatNumber(f.byCategory.API)} API findings`} />
        <Stat label="Data models" value={formatNumber(summary.database.models + summary.database.tables)} hint={`${formatNumber(f.byCategory.DATABASE)} database findings`} />
        <Stat
          label="Test files"
          value={formatNumber(summary.testing.testFiles)}
          hint={`${formatNumber(f.byCategory.TESTING)} testing findings`}
          tone={summary.testing.testFiles === 0 && summary.testing.sourceCodeLines > 0 ? "alert" : undefined}
        />
        <Stat label="Docs findings" value={formatNumber(f.byCategory.DOCUMENTATION)} hint={`${formatNumber(summary.documentation.markdownFiles)} Markdown ${summary.documentation.markdownFiles === 1 ? "file" : "files"}`} />
      </div>

      {/* min-w-0: grid cells may shrink below the endpoint table's width; the table scrolls inside its card. */}
      <div className="grid gap-6 lg:grid-cols-2 [&>*]:min-w-0">
        <ApiSection api={summary.api} />
        <DatabaseSection db={summary.database} />
        <TestingSection t={summary.testing} />
        <DocumentationSection d={summary.documentation} />
      </div>

      {f.total > 0 && (
        <section aria-label="Practice findings" className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">
            API, database, testing and documentation findings
            {f.truncated && (
              <span className="ml-2 font-normal text-muted-foreground">
                (the {formatNumber(f.stored)} most severe of {formatNumber(f.total)} are stored)
              </span>
            )}
          </h2>
          <FindingsList analysisId={analysisId} categories="API,DATABASE,TESTING,DOCUMENTATION" emptyMessage="No findings." />
        </section>
      )}

      <div className="flex items-start gap-3 rounded-lg border px-4 py-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p>
          Endpoints, schemas and tests are found from their declarations in the source; code is never run. Authentication or validation applied
          somewhere this analysis cannot see (an API gateway, a wrapper in another package) is not recognised, so the API checks say what was
          not seen rather than what is missing. Measured by {summary.analyzer} v{summary.analyzerVersion} in {formatNumber(summary.durationMs)} ms
          {summary.errors > 0 && `; ${formatNumber(summary.errors)} files could not be read`}.
        </p>
      </div>
    </div>
  );
}
