import { describe, expect, it } from "vitest";
import type { DependencySummary } from "@pd/analyzer/dependencies";
import { dependenciesQuerySchema } from "@pd/shared";
import {
  buildDependenciesWhere,
  buildEcosystemFacetWhere,
  dependencySummaryOf,
  vulnerabilityDetails,
} from "@/server/services/dependency-service";

const query = (params: Record<string, string> = {}) => dependenciesQuerySchema.parse(params);

describe("buildDependenciesWhere", () => {
  it("always scopes to the analysis and adds nothing by default", () => {
    expect(buildDependenciesWhere("a1", query())).toEqual({ analysisId: "a1" });
  });

  it("translates every filter", () => {
    expect(
      buildDependenciesWhere(
        "a1",
        query({ ecosystem: "npm,PyPI", scope: "direct", dev: "exclude", vulnerable: "true", unused: "false", q: "lod", manifest: "web/package.json" }),
      ),
    ).toEqual({
      analysisId: "a1",
      ecosystem: { in: ["npm", "PyPI"] },
      direct: true,
      dev: false,
      vulnIds: { isEmpty: false },
      unusedCandidate: false,
      name: { contains: "lod", mode: "insensitive" },
      manifestPath: "web/package.json",
    });
    expect(buildDependenciesWhere("a1", query({ scope: "transitive", dev: "only", vulnerable: "false" }))).toEqual({
      analysisId: "a1",
      direct: false,
      dev: true,
      vulnIds: { isEmpty: true },
    });
  });

  it("keeps every filter but the ecosystem for the ecosystem facet", () => {
    expect(buildEcosystemFacetWhere("a1", query({ ecosystem: "npm", vulnerable: "true" }))).toEqual({ analysisId: "a1", vulnIds: { isEmpty: false } });
  });
});

describe("dependenciesQuerySchema", () => {
  it("applies defaults and rejects unknown values", () => {
    expect(query()).toMatchObject({ page: 1, pageSize: 50, scope: "all", dev: "include", sort: "name" });
    expect(() => query({ ecosystem: "npm,rubygems" })).toThrow();
    expect(() => query({ vulnerable: "yes" })).toThrow();
    expect(() => query({ sort: "size" })).toThrow();
    expect(() => query({ pageSize: "1000" })).toThrow();
  });
});

describe("dependencySummaryOf", () => {
  it("returns the dependency summary only when the analyzer produced one", () => {
    const dep = { analyzer: "dependencies", totals: {} };
    expect(dependencySummaryOf({ dependencies: dep })).toBe(dep);
    expect(dependencySummaryOf({ codeMetrics: {} })).toBeNull();
    expect(dependencySummaryOf({ dependencies: { analyzer: "other" } })).toBeNull();
    expect(dependencySummaryOf(null)).toBeNull();
    expect(dependencySummaryOf("x")).toBeNull();
  });
});

describe("vulnerabilityDetails", () => {
  const summary = {
    vulnerable: [
      {
        ecosystem: "npm",
        name: "lodash",
        version: "4.17.20",
        direct: true,
        dev: false,
        manifestPath: "package.json",
        severity: "HIGH",
        fixedVersion: "4.17.21",
        advisories: [{ id: "GHSA-x", aliases: ["CVE-1"], summary: "bad", severity: "HIGH", score: 7.2, url: "https://osv.dev/vulnerability/GHSA-x" }],
      },
    ],
  } as unknown as DependencySummary;
  const row = { ecosystem: "npm", name: "lodash", resolvedVersion: "4.17.20", manifestPath: "package.json", vulnIds: ["GHSA-x"] };

  it("attaches severity, fix and advisories from the summary", () => {
    expect(vulnerabilityDetails(summary)(row)).toMatchObject({ severity: "HIGH", fixedVersion: "4.17.21", advisories: [{ id: "GHSA-x" }] });
  });

  it("returns null for safe packages and for vulnerable packages outside the summary", () => {
    const details = vulnerabilityDetails(summary);
    expect(details({ ...row, vulnIds: [] })).toBeNull();
    expect(details({ ...row, manifestPath: "web/package.json" })).toBeNull();
    expect(vulnerabilityDetails(null)(row)).toBeNull();
  });
});
