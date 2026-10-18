import { describe, expect, it } from "vitest";
import { isActive } from "@/components/app-nav";

describe("main navigation active state", () => {
  it("marks a link on its own page and the pages below it", () => {
    expect(isActive("/reports", "/reports")).toBe(true);
    expect(isActive("/reports/abc123", "/reports")).toBe(true);
    expect(isActive("/planner", "/planner")).toBe(true);
    // A shared prefix is not a sub-page.
    expect(isActive("/reportsx", "/reports")).toBe(false);
    expect(isActive("/new", "/reports")).toBe(false);
  });

  it("counts analysis pages under Repositories", () => {
    expect(isActive("/analysis/abc123", "/dashboard", ["/analysis"])).toBe(true);
    expect(isActive("/dashboard", "/dashboard", ["/analysis"])).toBe(true);
    expect(isActive("/analysis/abc123", "/dashboard")).toBe(false);
  });
});
