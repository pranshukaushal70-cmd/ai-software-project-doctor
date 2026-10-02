"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, Info, Package, ShieldCheck } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { api } from "@/lib/api-client";
import { cn, formatNumber } from "@/lib/utils";
import { FilterChip, FindingsList } from "./findings-list";
import { ECOSYSTEM_LABEL, SEVERITY_LABEL, SEVERITY_TONE } from "./labels";
import { Stat } from "./stat";
import type { DependenciesPageDto, DependencyDto, DependencySummaryDto, EcosystemDto, SeverityDto } from "./types";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

function SeverityBadge({ severity }: { severity: SeverityDto }) {
  return <Badge tone={SEVERITY_TONE[severity]}>{SEVERITY_LABEL[severity]}</Badge>;
}

const ecosystemLabel = (e: string) => ECOSYSTEM_LABEL[e] ?? e;

/** Explains whether, and how completely, versions were checked against the vulnerability database. */
export function VulnerabilityScanNotice({ scan }: { scan: DependencySummaryDto["vulnerabilityScan"] }) {
  if (scan.status === "completed") return null;
  const notice = {
    partial: {
      tone: "warn",
      title: "Vulnerability data is incomplete",
      body: `${scan.error ?? "Some advisory details could not be retrieved"}. Packages listed as vulnerable are correct, but severities or fixed versions may be missing.`,
    },
    failed: {
      tone: "warn",
      title: "Dependencies were not checked for vulnerabilities",
      body: `${scan.error ?? "The vulnerability database could not be queried"}. The dependency inventory below is complete; run a new analysis to retry the check.`,
    },
    disabled: {
      tone: "info",
      title: "Vulnerability lookup is disabled",
      body: "This server does not query OSV.dev (OSV_ENABLED=false), so dependencies are listed without vulnerability data.",
    },
    skipped: {
      tone: "info",
      title: "No exact versions to check",
      body: "No dependency has an exact version (from a lockfile or a pinned version), so nothing could be checked against OSV.dev. Commit your lockfile to enable the check.",
    },
  }[scan.status];
  return (
    <div
      role="status"
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3 text-sm",
        notice.tone === "warn" ? "border-sev-high/30 bg-sev-high/10" : "bg-accent/50 text-accent-foreground",
      )}
    >
      {notice.tone === "warn" ? <AlertTriangle className="mt-0.5 size-4 shrink-0 text-sev-high" aria-hidden /> : <Info className="mt-0.5 size-4 shrink-0" aria-hidden />}
      <div>
        <div className="font-medium">{notice.title}</div>
        <p className="text-muted-foreground">{notice.body}</p>
      </div>
    </div>
  );
}

function AdvisoryLinks({ advisories, max = 3 }: { advisories: DependencySummaryDto["vulnerable"][number]["advisories"]; max?: number }) {
  return (
    <ul className="flex flex-col gap-1">
      {advisories.slice(0, max).map((a) => {
        const cve = a.aliases.find((x) => x.startsWith("CVE-"));
        return (
          <li key={a.id} className="text-xs">
            <a href={a.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-mono underline-offset-2 hover:underline">
              {a.id}
              <ExternalLink className="size-3" aria-hidden />
            </a>
            {cve && <span className="ml-1.5 font-mono text-muted-foreground">{cve}</span>}
            <span className="ml-1.5 text-muted-foreground">
              {a.score !== null ? `CVSS ${a.score} · ` : ""}
              {a.summary}
            </span>
          </li>
        );
      })}
      {advisories.length > max && <li className="text-xs text-muted-foreground">and {advisories.length - max} more</li>}
    </ul>
  );
}

function Relationship({ d }: { d: Pick<DependencyDto, "direct" | "dev" | "manifestPath"> }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex flex-wrap gap-1">
        <Badge tone={d.direct ? "primary" : "neutral"}>{d.direct ? "Direct" : "Transitive"}</Badge>
        {d.dev && <Badge tone="neutral">dev</Badge>}
      </div>
      <span className="truncate font-mono text-xs text-muted-foreground" title={d.manifestPath}>
        {d.direct ? "declared in " : "locked in "}
        {d.manifestPath}
      </span>
    </div>
  );
}

function Status({ d }: { d: DependencyDto }) {
  if (d.vulnIds.length > 0) {
    return (
      <div className="flex flex-col items-start gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {d.vulnerability ? <SeverityBadge severity={d.vulnerability.severity} /> : <Badge tone="high">Vulnerable</Badge>}
          <span className="text-xs text-muted-foreground">
            {d.vulnIds.length} {d.vulnIds.length === 1 ? "advisory" : "advisories"}
          </span>
        </div>
        {d.vulnerability?.fixedVersion && <span className="text-xs">fixed in {d.vulnerability.fixedVersion}</span>}
      </div>
    );
  }
  if (d.dataSource) return <Badge tone="ok">No known issues</Badge>;
  return (
    <span className="text-xs text-muted-foreground" title="No exact version, a non-registry source, a private registry, or the lookup did not run.">
      Not checked
    </span>
  );
}

/** Table body states: loading (data null), error, empty, or rows. Exported for tests. */
export function DependencyTableView({
  data,
  items,
  error,
  filtered,
}: {
  data: DependenciesPageDto | null;
  items: DependencyDto[];
  error: string | null;
  filtered: boolean;
}) {
  if (error) return <p className="text-sm text-sev-critical">{error}</p>;
  if (!data) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-label="Loading dependencies">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    );
  }
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{filtered ? "No dependencies match these filters." : "No dependencies were found in this repository."}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="pb-2 font-medium">Package</th>
            <th className="pb-2 font-medium">Version</th>
            <th className="pb-2 font-medium">Relationship</th>
            <th className="pb-2 font-medium">Vulnerabilities</th>
          </tr>
        </thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id} className="border-t align-top">
              <td className="max-w-[260px] py-2 pr-3">
                <div className="truncate font-medium" title={d.name}>
                  {d.name}
                </div>
                <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                  {ecosystemLabel(d.ecosystem)}
                  {d.unusedCandidate && <Badge tone="neutral">not imported</Badge>}
                </div>
              </td>
              <td className="py-2 pr-3 font-mono text-xs">
                <div>{d.resolvedVersion ?? <span className="text-muted-foreground">unresolved</span>}</div>
                {d.versionSpec && d.versionSpec !== d.resolvedVersion && (
                  <div className="max-w-[180px] truncate text-muted-foreground" title={d.versionSpec}>
                    {d.versionSpec}
                  </div>
                )}
              </td>
              <td className="max-w-[260px] py-2 pr-3">
                <Relationship d={d} />
              </td>
              <td className="py-2">
                <Status d={d} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SCOPES = [
  { id: "all", label: "All" },
  { id: "direct", label: "Direct" },
  { id: "transitive", label: "Transitive" },
] as const;

function DependencyTable({ analysisId, ecosystems }: { analysisId: string; ecosystems: EcosystemDto[] }) {
  const [ecosystem, setEcosystem] = useState<EcosystemDto | null>(null);
  const [scope, setScope] = useState<(typeof SCOPES)[number]["id"]>("all");
  const [dev, setDev] = useState<"include" | "exclude" | "only">("include");
  const [vulnerableOnly, setVulnerableOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<DependenciesPageDto | null>(null);
  const [items, setItems] = useState<DependencyDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /** Bumped whenever the filters change, so a slow "load more" cannot append results for old filters. */
  const generation = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [search]);

  const fetchPage = useCallback(
    (page: number) => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), scope, dev });
      if (ecosystem) params.set("ecosystem", ecosystem);
      if (vulnerableOnly) params.set("vulnerable", "true");
      if (query) params.set("q", query);
      return api<DependenciesPageDto>(`/api/analysis/${analysisId}/dependencies?${params}`);
    },
    [analysisId, ecosystem, scope, dev, vulnerableOnly, query],
  );

  useEffect(() => {
    let cancelled = false;
    generation.current++;
    setData(null);
    setError(null);
    fetchPage(1)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setItems(d.dependencies);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  const loadMore = async () => {
    if (!data) return;
    const gen = generation.current;
    setLoadingMore(true);
    try {
      const next = await fetchPage(data.page + 1);
      if (gen !== generation.current) return;
      setData(next);
      setItems((prev) => [...prev, ...next.dependencies]);
    } catch (e) {
      if (gen === generation.current) setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  };

  const filtered = ecosystem !== null || scope !== "all" || dev !== "include" || vulnerableOnly || query !== "";

  return (
    <Card>
      <CardHeader>
        <CardTitle>All dependencies</CardTitle>
        <CardDescription>
          Direct dependencies are declared in a manifest; transitive ones appear only in a lockfile, pulled in by other packages.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="group" aria-label="Relationship">
            {SCOPES.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={scope === s.id}
                onClick={() => setScope(s.id)}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium", scope === s.id ? "bg-muted" : "text-muted-foreground hover:bg-muted/60")}
              >
                {s.label}
              </button>
            ))}
          </div>
          <select
            aria-label="Development dependencies"
            value={dev}
            onChange={(e) => setDev(e.target.value as typeof dev)}
            className="h-8 rounded-md border bg-card px-2 text-sm"
          >
            <option value="include">Runtime + dev</option>
            <option value="exclude">Runtime only</option>
            <option value="only">Dev only</option>
          </select>
          <FilterChip active={vulnerableOnly} onClick={() => setVulnerableOnly((v) => !v)}>
            Vulnerable only
          </FilterChip>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search packages"
            aria-label="Search packages"
            maxLength={200}
            className="h-8 min-w-[180px] flex-1 rounded-md border bg-card px-2.5 text-sm"
          />
        </div>
        {ecosystems.length > 1 && (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by ecosystem">
            <FilterChip active={ecosystem === null} onClick={() => setEcosystem(null)}>
              All ecosystems
            </FilterChip>
            {ecosystems.map((e) => (
              <FilterChip key={e} active={ecosystem === e} onClick={() => setEcosystem(ecosystem === e ? null : e)}>
                {ecosystemLabel(e)}
              </FilterChip>
            ))}
          </div>
        )}

        <DependencyTableView data={data} items={items} error={error} filtered={filtered} />

        {data && items.length < data.total && (
          <div className="flex items-center justify-center gap-3 text-sm text-muted-foreground">
            <span>
              Showing {formatNumber(items.length)} of {formatNumber(data.total)}
            </span>
            <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function DependenciesPanel({ analysisId, summary }: { analysisId: string; summary: DependencySummaryDto }) {
  const t = summary.totals;
  const scan = summary.vulnerabilityScan;
  const urgent = t.bySeverity.CRITICAL + t.bySeverity.HIGH;
  const hygiene = t.unpinned + t.nonRegistry + t.unusedCandidates;
  const lockfiles = summary.manifests.filter((m) => m.kind === "lockfile");
  const checked = scan.status === "completed" || scan.status === "partial";

  if (t.dependencies === 0) {
    return (
      <div className="flex flex-col gap-6">
        <Card>
          <CardContent className="flex items-start gap-3 pt-5">
            <Package className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
            {summary.manifests.length === 0 ? (
              <div>
                <div className="font-medium">No dependency manifests found</div>
                <p className="text-sm text-muted-foreground">
                  No package.json, requirements.txt, pyproject.toml, Pipfile, pom.xml, build.gradle, go.mod or Cargo.toml was found, so there
                  is nothing to check.
                </p>
              </div>
            ) : (
              <div>
                <div className="font-medium">No dependencies declared</div>
                <p className="text-sm text-muted-foreground">
                  {summary.manifests.map((m) => m.path).join(", ")} {summary.manifests.length === 1 ? "declares" : "declare"} no third-party
                  packages.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <VulnerabilityScanNotice scan={scan} />

      {checked && t.vulnerable === 0 && (
        <Card className="border-ok/30">
          <CardContent className="flex items-start gap-3 pt-5">
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden />
            <div>
              <div className="font-medium">No known vulnerabilities in the checked versions</div>
              <p className="text-sm text-muted-foreground">
                {formatNumber(scan.queried)} package versions were checked against OSV.dev.
                {scan.notChecked > 0 &&
                  ` ${formatNumber(scan.notChecked)} ${scan.notChecked === 1 ? "dependency" : "dependencies"} could not be checked (no exact version, or not from a public registry).`}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Dependencies" value={formatNumber(t.dependencies)} hint={`${formatNumber(t.direct)} direct · ${formatNumber(t.transitive)} transitive`} />
        <Stat
          label="Vulnerable"
          value={checked ? formatNumber(t.vulnerable) : "–"}
          hint={checked ? `${formatNumber(urgent)} critical or high · ${formatNumber(t.vulnerableDirect)} direct` : "not checked"}
          tone={t.vulnerable > 0 ? "alert" : undefined}
        />
        <Stat label="Advisories" value={checked ? formatNumber(t.advisories) : "–"} hint={`${formatNumber(t.resolved)} exact versions known`} />
        <Stat
          label="Hygiene issues"
          value={formatNumber(hygiene)}
          hint={`${formatNumber(t.unpinned)} unpinned · ${formatNumber(t.nonRegistry)} git/URL · ${formatNumber(t.unusedCandidates)} unused`}
        />
      </div>

      {summary.vulnerable.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Vulnerable packages</CardTitle>
            <CardDescription>Most severe first. Development-only packages are rated one level lower.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col">
              {summary.vulnerable.map((v) => (
                <li key={`${v.ecosystem}:${v.name}@${v.version}:${v.manifestPath}`} className="grid gap-2 border-t py-3 first:border-t-0 first:pt-0 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <SeverityBadge severity={v.severity} />
                      <span className="font-medium">{v.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">{v.version}</span>
                    </div>
                    <Relationship d={v} />
                    <div className="text-xs">
                      {v.fixedVersion ? (
                        <>
                          Upgrade to <span className="font-mono font-medium">{v.fixedVersion}</span> or later
                        </>
                      ) : (
                        <span className="text-muted-foreground">No fixed release covers every advisory</span>
                      )}
                    </div>
                  </div>
                  <AdvisoryLinks advisories={v.advisories} />
                </li>
              ))}
            </ul>
            {t.vulnerable > summary.vulnerable.length && (
              <p className="mt-3 text-xs text-muted-foreground">
                Showing the {formatNumber(summary.vulnerable.length)} most severe of {formatNumber(t.vulnerable)} vulnerable packages; filter the
                table below by &ldquo;Vulnerable only&rdquo; to see all.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Ecosystems</CardTitle>
            <CardDescription>Packages per package manager.</CardDescription>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 font-medium">Ecosystem</th>
                  <th className="pb-2 text-right font-medium">Packages</th>
                  <th className="pb-2 text-right font-medium">Direct</th>
                  <th className="pb-2 text-right font-medium">Vulnerable</th>
                </tr>
              </thead>
              <tbody>
                {summary.byEcosystem.map((e) => (
                  <tr key={e.ecosystem} className="border-t">
                    <td className="py-1.5 font-medium">{ecosystemLabel(e.ecosystem)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatNumber(e.dependencies)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatNumber(e.direct)}</td>
                    <td className={cn("py-1.5 text-right tabular-nums", e.vulnerable > 0 ? "text-sev-critical" : "text-muted-foreground")}>
                      {checked ? formatNumber(e.vulnerable) : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Manifests and lockfiles</CardTitle>
            <CardDescription>
              {lockfiles.length > 0
                ? "Manifests declare direct dependencies; lockfiles pin exact versions and list transitive ones."
                : "No lockfile was found, so exact versions are only known where a manifest pins them."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-1.5">
              {summary.manifests.map((m) => (
                <li key={m.path} className="flex items-center gap-2 text-sm">
                  <Badge tone={m.kind === "lockfile" ? "neutral" : "primary"}>{m.kind}</Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs" title={m.path}>
                    {m.path}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatNumber(m.dependencies)} {m.kind === "lockfile" ? "transitive" : "declared"}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <DependencyTable analysisId={analysisId} ecosystems={summary.byEcosystem.map((e) => e.ecosystem)} />

      {summary.findings.total > 0 && (
        <section aria-label="Dependency findings" className="flex flex-col gap-3">
          <h2 className="text-sm font-medium">Dependency findings</h2>
          <FindingsList analysisId={analysisId} categories="DEPENDENCY" emptyMessage="No dependency findings." />
        </section>
      )}

      <div className="flex items-start gap-3 rounded-lg border px-4 py-3 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        <div className="flex flex-col gap-1">
          <p>
            Manifests and lockfiles are read without installing anything. Exact versions of registry packages are checked against the
            OSV.dev vulnerability database (package name and version only). npm and Cargo packages that the lockfile (or, for npm, the
            repository&rsquo;s .npmrc/.yarnrc.yml) shows to come from a private registry are not sent; PyPI, Maven and Go do not record
            the registry, so their packages are sent whenever the exact version is known. A listed advisory means the version is
            affected, not that the vulnerable code is reachable in this project.
          </p>
          <p>
            &ldquo;Not imported&rdquo; is a candidate only: packages loaded by tools, plugins or configuration may not appear in imports. Measured by{" "}
            {summary.analyzer} v{summary.analyzerVersion} in {formatNumber(summary.durationMs)} ms
            {checked && ` (vulnerability lookup ${formatNumber(scan.durationMs)} ms)`}.
          </p>
        </div>
      </div>
    </div>
  );
}
