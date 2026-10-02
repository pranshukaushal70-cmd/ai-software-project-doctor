import { Check, Info, X } from "lucide-react";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { formatBytes, formatNumber } from "@/lib/utils";
import { FileTree } from "./file-tree";
import { LANGUAGE_NAMES } from "./labels";
import type { Detection, ScanSummaryDto } from "./types";

const LANGUAGE_COLORS: Record<string, string> = {
  javascript: "oklch(0.83 0.16 95)",
  typescript: "oklch(0.58 0.14 250)",
  python: "oklch(0.6 0.12 235)",
  java: "oklch(0.65 0.15 45)",
  c: "oklch(0.55 0.03 250)",
  cpp: "oklch(0.55 0.15 340)",
};
const FALLBACK_COLORS = ["oklch(0.7 0.1 160)", "oklch(0.65 0.12 300)", "oklch(0.7 0.08 20)", "oklch(0.6 0.05 200)"];


function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function DetectionList({ title, items }: { title: string; items: Detection[] }) {
  return (
    <div>
      <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">None detected</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((d) => (
            <li key={`${d.name}-${d.evidence}`} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="font-medium">{d.name}</span>
              <span className="truncate font-mono text-xs text-muted-foreground" title={d.evidence}>
                {d.evidence}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Analysis modules in pipeline order, with the tab that shows each one's results. */
const MODULES = [
  { id: "repository-scan", label: "repository scan", tab: "Overview" },
  { id: "code-metrics", label: "code metrics & static analysis", tab: "Code quality" },
  { id: "security", label: "security analysis", tab: "Security" },
  { id: "dependencies", label: "dependency analysis", tab: "Dependencies" },
  { id: "architecture", label: "architecture analysis", tab: "Architecture" },
  { id: "practices", label: "API, database, testing & documentation analysis", tab: "Practices" },
  { id: "health-score", label: "health scoring", tab: "Health" },
] as const;

const joinList = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** Which analysis modules produced this result, which did not run, and what is still to come. Exported for tests. */
export function ModulesNotice({ modulesRun }: { modulesRun: string[] }) {
  const ran = MODULES.filter((m) => modulesRun.includes(m.id));
  const missing = MODULES.filter((m) => !modulesRun.includes(m.id));
  return (
    <div className="flex items-start gap-3 rounded-lg border bg-accent/50 px-4 py-3 text-sm">
      <Info className="mt-0.5 size-4 shrink-0 text-accent-foreground" />
      <p className="text-accent-foreground">
        This run performed{" "}
        {ran.map((m, i) => (
          <span key={m.id}>
            {i > 0 && (i === ran.length - 1 ? " and " : ", ")}
            <strong>{m.label}</strong>
          </span>
        ))}
        {ran.length > 1 && <> (see the {joinList(ran.map((m) => m.tab))} tabs)</>}.{" "}
        {missing.length > 0 && <>It was made by an earlier analyzer version without {joinList(missing.map((m) => m.label))}; run a new analysis to include them. </>}
        Git history insights and AI recommendations are added in later analyzer versions.
      </p>
    </div>
  );
}

function CheckItem({ ok, label, detail }: { ok: boolean; label: string; detail?: string | null }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {ok ? <Check className="size-4 text-ok" aria-label="present" /> : <X className="size-4 text-sev-high" aria-label="missing" />}
      <span>{label}</span>
      {detail && <span className="font-mono text-xs text-muted-foreground">{detail}</span>}
    </li>
  );
}

export function ScanOverview({ analysisId, summary }: { analysisId: string; summary: ScanSummaryDto }) {
  const { totals, languages } = summary;
  const codeLines = languages.reduce((n, l) => n + l.lines, 0);
  const source = totals.byKind.SOURCE ?? 0;
  const tests = totals.byKind.TEST ?? 0;
  const committedEnv = summary.envFiles.filter((f) => !f.isTemplate);
  const frameworks = summary.frameworks;

  return (
    <div className="flex flex-col gap-6">
      <ModulesNotice modulesRun={summary.modulesRun} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Files analysed" value={formatNumber(totals.files)} hint={formatBytes(totals.bytes)} />
        <Stat label="Lines of code" value={formatNumber(codeLines)} hint="physical lines in source & test files" />
        <Stat label="Source files" value={formatNumber(source)} hint={summary.primaryLanguage ? `mostly ${LANGUAGE_NAMES[summary.primaryLanguage] ?? summary.primaryLanguage}` : undefined} />
        <Stat
          label="Test files"
          value={formatNumber(tests)}
          hint={source > 0 ? `${((tests / source) * 100).toFixed(1)}% test/source file ratio` : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Languages</CardTitle>
            <CardDescription>By lines in source and test files. Bold languages get deep analysis.</CardDescription>
          </CardHeader>
          <CardContent>
            {languages.length === 0 ? (
              <p className="text-sm text-muted-foreground">No source files detected.</p>
            ) : (
              <>
                <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  {languages.map((l, i) => (
                    <div
                      key={l.language}
                      style={{
                        width: `${(l.lines / Math.max(codeLines, 1)) * 100}%`,
                        background: LANGUAGE_COLORS[l.language] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length],
                      }}
                    />
                  ))}
                </div>
                <table className="mt-4 w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="pb-2 font-medium">Language</th>
                      <th className="pb-2 text-right font-medium">Files</th>
                      <th className="pb-2 text-right font-medium">Lines</th>
                      <th className="pb-2 text-right font-medium">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {languages.map((l, i) => (
                      <tr key={l.language} className="border-t">
                        <td className="py-1.5">
                          <span className="flex items-center gap-2">
                            <span
                              className="size-2.5 rounded-sm"
                              style={{ background: LANGUAGE_COLORS[l.language] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length] }}
                            />
                            <span className={l.analyzed ? "font-medium" : "text-muted-foreground"}>
                              {LANGUAGE_NAMES[l.language] ?? l.language}
                            </span>
                          </span>
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{formatNumber(l.files)}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatNumber(l.lines)}</td>
                        <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                          {((l.lines / Math.max(codeLines, 1)) * 100).toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>File composition</CardTitle>
            <CardDescription>How files were classified.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              {Object.entries(totals.byKind)
                .filter(([, n]) => n > 0)
                .sort((a, b) => b[1] - a[1])
                .map(([kind, n]) => (
                  <li key={kind} className="flex items-center justify-between">
                    <span className="capitalize">{kind.toLowerCase()}</span>
                    <span className="tabular-nums text-muted-foreground">{formatNumber(n)}</span>
                  </li>
                ))}
            </ul>
            <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
              Skipped {summary.ignored.dirs.length}
              {summary.ignored.dirsTruncated ? "+" : ""} vendored/build directories and {summary.ignored.gitignoredFiles} gitignored
              files.
              {summary.oversizedFiles.length > 0 && ` ${summary.oversizedFiles.length} files exceeded the size limit and were not read.`}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Detected stack</CardTitle>
          <CardDescription>Each detection shows the file and key it was derived from.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <DetectionList title="Frameworks & libraries" items={frameworks} />
          <DetectionList title="Package managers" items={summary.packageManagers} />
          <DetectionList title="Build systems" items={summary.buildSystems} />
          <DetectionList title="CI/CD" items={summary.ci} />
          <DetectionList title="Containers" items={summary.containers} />
          <DetectionList title="Entry points" items={summary.entryPoints} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Documentation files</CardTitle>
            <CardDescription>Presence only; README content, license and links are checked in the Practices tab.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2">
              <CheckItem ok={!!summary.docs.readme} label="README" detail={summary.docs.readme} />
              <CheckItem ok={!!summary.docs.license} label="License" detail={summary.docs.license} />
              <CheckItem ok={!!summary.docs.contributing} label="Contribution guide" detail={summary.docs.contributing} />
              <CheckItem ok={!!summary.docs.changelog} label="Changelog" detail={summary.docs.changelog} />
              <CheckItem ok={summary.docs.docsDir} label="docs/ directory" />
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Environment files</CardTitle>
            <CardDescription>Committed .env files often contain credentials.</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.envFiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No .env files found in the repository.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {summary.envFiles.map((f) => (
                  <li key={f.path} className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-mono">{f.path}</span>
                    {f.isTemplate ? <Badge tone="ok">template</Badge> : <Badge tone="high">committed</Badge>}
                  </li>
                ))}
              </ul>
            )}
            {committedEnv.length > 0 && (
              <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
                {summary.security
                  ? "Their contents were checked for secrets; see the Security tab. Rotate any real credentials they contain."
                  : "This analysis predates secret detection: review them manually and rotate any real credentials they contain."}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Repository tree</CardTitle>
          <CardDescription>Vendored and build output directories are excluded.</CardDescription>
        </CardHeader>
        <CardContent>
          <FileTree analysisId={analysisId} />
        </CardContent>
      </Card>
    </div>
  );
}
