import { describe, expect, it } from "vitest";
import { findingsQuerySchema, triageInputSchema } from "./schemas";

describe("findingsQuerySchema", () => {
  it("parses comma-separated filters and pagination defaults", () => {
    expect(findingsQuerySchema.parse({ severity: "HIGH, MEDIUM", type: "high-complexity,unused-import" })).toEqual({
      page: 1,
      pageSize: 50,
      severity: ["HIGH", "MEDIUM"],
      type: ["high-complexity", "unused-import"],
      // Triaged findings are listed unless a caller explicitly asks to hide them.
      triage: "all",
    });
    expect(findingsQuerySchema.parse({ category: "CODE_QUALITY", page: "3", path: "src/a.ts" })).toMatchObject({
      page: 3,
      category: ["CODE_QUALITY"],
      path: "src/a.ts",
    });
  });

  it("rejects unknown severities, malformed types and oversized lists", () => {
    expect(() => findingsQuerySchema.parse({ severity: "SEVERE" })).toThrow();
    expect(() => findingsQuerySchema.parse({ type: "Robert'); DROP TABLE" })).toThrow();
    expect(() => findingsQuerySchema.parse({ type: Array.from({ length: 21 }, (_, i) => `t${i}`).join(",") })).toThrow();
    expect(() => findingsQuerySchema.parse({ pageSize: "1000" })).toThrow();
    expect(() => findingsQuerySchema.parse({ triage: "hidden" })).toThrow();
  });
});

describe("triageInputSchema", () => {
  it("accepts the two statuses, trims the reason and drops an empty one", () => {
    expect(triageInputSchema.parse({ status: "EXPECTED", reason: "  fake key in a fixture " })).toEqual({ status: "EXPECTED", reason: "fake key in a fixture" });
    expect(triageInputSchema.parse({ status: "IGNORED", reason: "   " })).toEqual({ status: "IGNORED", reason: undefined });
  });

  it("rejects other statuses and overlong reasons", () => {
    expect(() => triageInputSchema.parse({ status: "SUPPRESSED" })).toThrow();
    expect(() => triageInputSchema.parse({ status: "EXPECTED", reason: "x".repeat(501) })).toThrow();
  });
});
