import { describe, expect, it } from "vitest";
import { buildFacetWhere, buildFindingsWhere } from "@/server/services/findings-service";

describe("buildFindingsWhere", () => {
  it("always scopes to the analysis", () => {
    expect(buildFindingsWhere("a1", {})).toEqual({ analysisId: "a1" });
  });

  it("adds only the filters that are present", () => {
    expect(buildFindingsWhere("a1", { severity: ["HIGH"], type: ["unused-import"], path: "src/a.ts" })).toEqual({
      analysisId: "a1",
      severity: { in: ["HIGH"] },
      type: { in: ["unused-import"] },
      file: { path: "src/a.ts" },
    });
    expect(buildFindingsWhere("a1", { severity: [], category: ["CODE_QUALITY"] })).toEqual({
      analysisId: "a1",
      category: { in: ["CODE_QUALITY"] },
    });
  });
});

describe("buildFacetWhere", () => {
  it("keeps the category/path scope but drops the facet filters themselves", () => {
    expect(
      buildFacetWhere("a1", { severity: ["HIGH"], type: ["unused-import"], category: ["CODE_QUALITY"], path: "src/a.ts" }),
    ).toEqual({ analysisId: "a1", category: { in: ["CODE_QUALITY"] }, file: { path: "src/a.ts" } });
    expect(buildFacetWhere("a1", { severity: ["LOW"] })).toEqual({ analysisId: "a1" });
  });
});

describe("triage filter", () => {
  const triaged = ["fp1", "fp2"];

  it("shows everything by default, including triaged findings", () => {
    expect(buildFindingsWhere("a1", {}, triaged)).toEqual({ analysisId: "a1" });
    expect(buildFindingsWhere("a1", { triage: "all" }, triaged)).toEqual({ analysisId: "a1" });
  });

  it("hides only the triaged fingerprints of this repository when asked", () => {
    expect(buildFindingsWhere("a1", { triage: "untriaged" }, triaged)).toEqual({ analysisId: "a1", fingerprint: { notIn: ["fp1", "fp2"] } });
    expect(buildFindingsWhere("a1", { triage: "untriaged" }, [])).toEqual({ analysisId: "a1" });
  });

  it("can list only triaged findings (none when nothing is triaged)", () => {
    expect(buildFindingsWhere("a1", { triage: "triaged" }, triaged)).toEqual({ analysisId: "a1", fingerprint: { in: ["fp1", "fp2"] } });
    expect(buildFindingsWhere("a1", { triage: "triaged" }, [])).toEqual({ analysisId: "a1", fingerprint: { in: [] } });
  });

  it("applies the triage scope to facet counts as well", () => {
    expect(buildFacetWhere("a1", { severity: ["HIGH"], triage: "untriaged" }, triaged)).toEqual({ analysisId: "a1", fingerprint: { notIn: ["fp1", "fp2"] } });
  });
});
