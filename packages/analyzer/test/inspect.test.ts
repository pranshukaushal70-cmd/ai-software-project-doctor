import { describe, expect, it } from "vitest";
import { kindOfPath } from "../src/classify";
import { inspectSource } from "../src/inspect";

describe("inspectSource", () => {
  it("counts syntax errors in analysed languages", async () => {
    expect(await inspectSource("src/a.ts", "export const a = 1;\n")).toMatchObject({ parsed: true, syntaxErrors: 0 });
    expect((await inspectSource("src/a.ts", "export const a = (1;\n")).syntaxErrors).toBeGreaterThan(0);
    expect((await inspectSource("app/a.py", "def f(:\n  pass\n")).syntaxErrors).toBeGreaterThan(0);
    // Not an analysed language: nothing to parse.
    expect(await inspectSource("README.md", "# (unbalanced\n")).toMatchObject({ parsed: false, syntaxErrors: 0 });
  });

  it("reports insecure patterns in production source only, with content-based keys", async () => {
    const code = "export function run(input: string) {\n  return eval(input);\n}\n";
    const src = await inspectSource("src/run.ts", code);
    expect(src.findings).toEqual([expect.objectContaining({ ruleId: "injection/dynamic-code-execution", severity: "HIGH", line: 2 })]);
    const moved = await inspectSource("src/run.ts", `// moved\n\n${code}`);
    expect(moved.findings[0]!.key).toBe(src.findings[0]!.key);
    expect(moved.findings[0]!.line).toBe(4);
    expect((await inspectSource("tests/run.test.ts", code)).findings).toEqual([]);
  });

  it("finds credentials in any text file without exposing them", async () => {
    const key = ["sk", "live", "51HaBcDeFgHiJkLmNoPqRsTuV"].join("_");
    const r = await inspectSource("config/app.yml", `stripe_key: ${key}\n`);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain(key);
  });

  it("classifies paths it has not scanned", () => {
    expect(kindOfPath("src/a.ts")).toBe("SOURCE");
    expect(kindOfPath("tests/a.test.ts")).toBe("TEST");
    expect(kindOfPath("README.md")).toBe("DOCUMENTATION");
  });
});
