import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DependenciesPanel, DependencyTableView, VulnerabilityScanNotice } from "@/components/analysis/dependencies-panel";
import type { DependenciesPageDto, DependencyDto } from "@/components/analysis/types";
import { dependencySummary } from "./ui-fixtures";

const render = (summary = dependencySummary()) => renderToStaticMarkup(createElement(DependenciesPanel, { analysisId: "a1", summary }));

describe("DependenciesPanel", () => {
  it("lists vulnerable packages with their relationship, fix and advisories", () => {
    const html = render();
    expect(html).toContain("Vulnerable packages");
    expect(html).toContain("lodash");
    expect(html).toContain("declared in package.json");
    expect(html).toContain("Upgrade to <span");
    expect(html).toContain("4.17.21");
    expect(html).toContain('href="https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm"');
    expect(html).toContain("CVE-2021-23337");
    expect(html).toContain("CVSS 7.2");
    // Manifests and lockfiles explain where direct and transitive dependencies come from.
    expect(html).toContain("Manifests and lockfiles");
    expect(html).toContain("package-lock.json");
    expect(html).toContain("Dependency findings");
  });

  it("renders the dependency table in its loading state until data arrives", () => {
    expect(render()).toContain('aria-label="Loading dependencies"');
  });

  it("reports a clean result without claiming unchecked packages are safe", () => {
    const html = render(
      dependencySummary({
        totals: { ...dependencySummary().totals, vulnerable: 0, vulnerableDirect: 0, advisories: 0, bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 } },
        vulnerable: [],
        vulnerabilityScan: { status: "completed", source: "osv.dev", queried: 2, notChecked: 1, error: null, durationMs: 10 },
      }),
    );
    expect(html).toContain("No known vulnerabilities in the checked versions");
    expect(html).toContain("1 dependency could not be checked");
    expect(html).not.toContain("Vulnerable packages");
  });

  it("explains a failed lookup and does not show vulnerability counts", () => {
    const html = render(
      dependencySummary({
        vulnerable: [],
        vulnerabilityScan: { status: "failed", source: "osv.dev", queried: 3, notChecked: 0, error: "OSV.dev could not be reached", durationMs: 5 },
      }),
    );
    expect(html).toContain("Dependencies were not checked for vulnerabilities");
    expect(html).toContain("OSV.dev could not be reached");
    expect(html).toContain("not checked");
    expect(html).not.toContain("No known vulnerabilities");
  });

  it("distinguishes a repository without manifests from manifests without dependencies", () => {
    const empty = { ...dependencySummary().totals, dependencies: 0, direct: 0, transitive: 0 };
    expect(render(dependencySummary({ manifests: [], totals: empty }))).toContain("No dependency manifests found");
    const html = render(dependencySummary({ manifests: [{ path: "package.json", ecosystem: "npm", kind: "manifest", dependencies: 0 }], totals: empty }));
    expect(html).toContain("No dependencies declared");
    expect(html).toContain("package.json declares no third-party packages");
  });
});

describe("VulnerabilityScanNotice", () => {
  const scan = dependencySummary().vulnerabilityScan;
  const notice = (status: typeof scan.status, error: string | null = null) =>
    renderToStaticMarkup(createElement(VulnerabilityScanNotice, { scan: { ...scan, status, error } }));

  it("says nothing for a completed lookup and explains every other status", () => {
    expect(notice("completed")).toBe("");
    expect(notice("disabled")).toContain("OSV_ENABLED=false");
    expect(notice("skipped")).toContain("Commit your lockfile");
    expect(notice("partial", "Some advisory details could not be retrieved")).toContain("Vulnerability data is incomplete");
  });
});

describe("DependencyTableView", () => {
  const row = (over: Partial<DependencyDto>): DependencyDto => ({
    id: "d1",
    ecosystem: "npm",
    name: "pkg",
    versionSpec: "^1.0.0",
    resolvedVersion: "1.2.0",
    direct: true,
    dev: false,
    manifestPath: "package.json",
    vulnIds: [],
    dataSource: "osv.dev",
    unusedCandidate: false,
    vulnerability: null,
    ...over,
  });
  const page = (dependencies: DependencyDto[]): DependenciesPageDto => ({
    summary: null,
    dependencies,
    page: 1,
    pageSize: 50,
    total: dependencies.length,
    facets: { ecosystem: [] },
  });
  const view = (props: Parameters<typeof DependencyTableView>[0]) => renderToStaticMarkup(createElement(DependencyTableView, props));

  it("shows loading, error and empty states", () => {
    expect(view({ data: null, items: [], error: null, filtered: false })).toContain("Loading dependencies");
    expect(view({ data: null, items: [], error: "Analysis not found", filtered: false })).toContain("Analysis not found");
    expect(view({ data: page([]), items: [], error: null, filtered: false })).toContain("No dependencies were found");
    expect(view({ data: page([]), items: [], error: null, filtered: true })).toContain("No dependencies match these filters");
  });

  it("shows each dependency's version, relationship and vulnerability status", () => {
    const items = [
      row({ id: "1", name: "safe-pkg" }),
      row({ id: "2", name: "deep-pkg", direct: false, dev: true, manifestPath: "package-lock.json", versionSpec: "3.0.0", resolvedVersion: "3.0.0" }),
      row({ id: "3", name: "unchecked", resolvedVersion: null, dataSource: null, unusedCandidate: true }),
      row({ id: "4", name: "bad-pkg", vulnIds: ["GHSA-a", "GHSA-b"], vulnerability: { severity: "CRITICAL", fixedVersion: "2.0.0", advisories: [] } }),
      row({ id: "5", name: "bad-no-details", vulnIds: ["GHSA-c"] }),
    ];
    const html = view({ data: page(items), items, error: null, filtered: false });
    expect(html).toContain("No known issues");
    expect(html).toContain("locked in package-lock.json");
    expect(html).toContain("Transitive");
    expect(html).toContain(">dev<");
    expect(html).toContain("Not checked");
    expect(html).toContain("not imported");
    expect(html).toContain("unresolved");
    expect(html).toContain("Critical");
    expect(html).toContain("2 advisories");
    expect(html).toContain("fixed in 2.0.0");
    expect(html).toContain("Vulnerable");
    // An exact pin equal to the resolved version is not repeated.
    expect(html.match(/3\.0\.0/g)).toHaveLength(1);
  });
});
