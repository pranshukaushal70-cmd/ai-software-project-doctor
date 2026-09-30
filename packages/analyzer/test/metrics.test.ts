import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { analyzeCode, redactSecrets, type CodeAnalysis, type CodeFinding } from "../src/metrics";
import { findDuplicates } from "../src/metrics/duplication";
import { scanRepository } from "../src/scanner";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "polyglot");

async function analyzeFixture(root: string) {
  const scan = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
  return analyzeCode(scan.files);
}

/** Analyse in-memory files written to a temporary repository. */
async function analyzeFiles(files: Record<string, string>, opts?: Parameters<typeof analyzeCode>[1]): Promise<CodeAnalysis> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pd-metrics-test-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
    const scan = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
    return await analyzeCode(scan.files, opts);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const metricsOf = (res: CodeAnalysis, p: string) => {
  const file = res.files.find((f) => f.path === p);
  if (!file) throw new Error(`no metrics for ${p}`);
  return file.metrics;
};
const findingsOf = (res: CodeAnalysis, p: string, ruleId?: string) =>
  res.findings.filter((f) => f.path === p && (!ruleId || f.ruleId === ruleId));

describe("analyzeCode on the polyglot fixture", () => {
  let res: CodeAnalysis;
  beforeAll(async () => {
    res = await analyzeFixture(FIXTURE);
  });

  it("analyses all six languages with the right grammar", () => {
    const grammars = Object.fromEntries(res.files.map((f) => [f.path, f.grammar]));
    expect(grammars).toMatchObject({
      "src/orders.ts": "typescript",
      "src/utils/csv.js": "javascript",
      "app/pipeline.py": "python",
      "java/src/main/java/com/demo/InventoryService.java": "java",
      "native/buffer.c": "c",
      "native/buffer.h": "c",
      "native/matrix.cpp": "cpp",
      // C++-only syntax in a .h file falls back to the C++ grammar.
      "native/matrix.h": "cpp",
    });
    expect(res.files.every((f) => f.metrics.parseErrors === 0)).toBe(true);
  });

  it("counts code, comment, blank and logical lines", () => {
    expect(metricsOf(res, "src/orders.ts")).toMatchObject({ lines: 72, codeLines: 62, commentLines: 4, blankLines: 6 });
    // Module, class and method docstrings count as comments, not code.
    expect(metricsOf(res, "app/pipeline.py")).toMatchObject({ lines: 41, codeLines: 30, commentLines: 4, blankLines: 7 });
    expect(metricsOf(res, "native/buffer.h")).toMatchObject({ lines: 7, codeLines: 4, commentLines: 1, blankLines: 2 });
    for (const f of res.files) {
      const m = f.metrics;
      expect(m.codeLines + m.commentLines + m.blankLines).toBe(m.lines);
      expect(m.logicalLines).toBeGreaterThan(0);
    }
  });

  it("counts functions and classes, qualifying methods with their class", () => {
    const orders = metricsOf(res, "src/orders.ts");
    expect(orders).toMatchObject({ functionCount: 3, classCount: 1 });
    expect(orders.functions.map((f) => f.name)).toEqual(["processOrder", "OrderQueue.push", "OrderQueue.size"]);
    expect(orders.classes[0]).toMatchObject({ name: "OrderQueue", methods: 2 });

    const py = metricsOf(res, "app/pipeline.py");
    expect(py.functions.map((f) => f.name)).toEqual(["Pipeline.__init__", "Pipeline.run", "Pipeline.classify", "_helper"]);
    // `self` is not counted as a parameter.
    expect(py.functions.find((f) => f.name === "Pipeline.classify")?.parameters).toBe(2);

    expect(metricsOf(res, "native/matrix.cpp").classes[0]).toMatchObject({ name: "Matrix", methods: 3 });
    expect(metricsOf(res, "native/buffer.c")).toMatchObject({ functionCount: 3, classCount: 0 });
  });

  it("computes cyclomatic complexity per function", () => {
    const cc = (p: string, name: string) => metricsOf(res, p).functions.find((f) => f.name === name)?.complexity;
    expect(cc("src/orders.ts", "processOrder")).toBe(15);
    expect(cc("app/pipeline.py", "Pipeline.classify")).toBe(13);
    expect(cc("java/src/main/java/com/demo/InventoryService.java", "InventoryService.reserve")).toBe(11);
    expect(cc("native/buffer.c", "buffer_fill")).toBe(7);
    expect(cc("native/buffer.c", "clamp")).toBe(3);
    expect(cc("native/matrix.cpp", "Matrix.sumPositive")).toBe(7);
  });

  it("measures nesting depth without counting else-if as a level", () => {
    const nest = (p: string) => metricsOf(res, p).maxNesting;
    expect(nest("src/orders.ts")).toBe(5);
    expect(nest("java/src/main/java/com/demo/InventoryService.java")).toBe(2);
    expect(nest("native/matrix.cpp")).toBe(6);
    expect(nest("app/pipeline.py")).toBe(4);
  });

  it("extracts imports and exports", () => {
    expect(metricsOf(res, "src/orders.ts")).toMatchObject({
      imports: ["node:fs/promises", "./format"],
      exports: ["Order", "processOrder", "OrderQueue"],
    });
    expect(metricsOf(res, "src/utils/csv.js")).toMatchObject({ imports: ["path"], exports: ["toCsvRows", "outputName"] });
    expect(metricsOf(res, "src/legacy/export.js").exports).toEqual(["exportAll"]);
    expect(metricsOf(res, "app/pipeline.py")).toMatchObject({ imports: ["json", "os", "typing"], exports: ["Pipeline"] });
    expect(metricsOf(res, "java/src/main/java/com/demo/InventoryService.java")).toMatchObject({
      imports: ["java.util.ArrayList", "java.util.List", "java.util.Map"],
      exports: ["InventoryService"],
    });
    expect(metricsOf(res, "native/buffer.c")).toMatchObject({ imports: ["stdio.h", "stdlib.h", "buffer.h"], exports: ["buffer_fill"] });
  });

  it("reports exactly the intentional issues, each with evidence and a location", () => {
    const summary = res.findings.map((f) => `${f.ruleId} ${f.path}:${f.line}`).sort();
    expect(summary).toEqual(
      [
        "complexity/high-cyclomatic app/pipeline.py:21",
        "complexity/high-cyclomatic java/src/main/java/com/demo/InventoryService.java:11",
        "complexity/high-cyclomatic src/orders.ts:16",
        "complexity/deep-nesting native/matrix.cpp:18",
        "complexity/deep-nesting src/orders.ts:33",
        "dead-code/unreachable app/pipeline.py:33",
        "dead-code/unreachable native/buffer.c:27",
        "dead-code/unreachable src/orders.ts:58",
        "dead-code/unused-import app/pipeline.py:3",
        "dead-code/unused-import java/src/main/java/com/demo/InventoryService.java:5",
        "dead-code/unused-import src/orders.ts:1",
        "dead-code/unused-private java/src/main/java/com/demo/InventoryService.java:40",
        "dead-code/unused-private native/buffer.c:5",
        "duplication/duplicate-block src/utils/csv.js:3",
        "smell/bare-except app/pipeline.py:17",
        "smell/debugger-statement src/orders.ts:65",
        "smell/empty-catch app/pipeline.py:17",
        "smell/empty-catch java/src/main/java/com/demo/InventoryService.java:35",
        "smell/empty-catch native/matrix.cpp:22",
        "smell/empty-catch src/orders.ts:56",
        "smell/long-parameter-list src/orders.ts:16",
        "smell/todo-comment app/pipeline.py:40",
        "smell/todo-comment src/orders.ts:4",
      ].sort(),
    );
    for (const f of res.findings) {
      expect(f).toMatchObject({ category: "CODE_QUALITY", analyzer: "code-metrics", analyzerVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
      expect(f.evidence.length).toBeGreaterThan(20);
      expect(f.impact.length).toBeGreaterThan(20);
      expect(f.recommendation.length).toBeGreaterThan(20);
      expect(f.endLine).toBeGreaterThanOrEqual(f.line);
      expect(f.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(new Set(res.findings.map((f) => f.fingerprint)).size).toBe(res.findings.length);
  });

  it("explains findings with concrete evidence", () => {
    const [complexity] = findingsOf(res, "src/orders.ts", "complexity/high-cyclomatic");
    expect(complexity!.evidence).toContain("cyclomatic complexity 15 (limit 10)");
    expect(complexity!.evidence).toContain("5 if/else-if");
    expect(complexity!.severity).toBe("MEDIUM");
    expect(complexity!.data).toMatchObject({ complexity: 15, limit: 10 });

    const [nesting] = findingsOf(res, "native/matrix.cpp", "complexity/deep-nesting");
    expect(nesting!.evidence).toContain("for → for → if → try → if → if");

    const [dup] = findingsOf(res, "src/utils/csv.js", "duplication/duplicate-block");
    expect(dup!.evidence).toMatch(/^Lines 3–16 \(\d+ tokens\) are identical.*lines 4–17 of src\/legacy\/export\.js\.$/);
    expect(dup!.endLine).toBe(16);

    const [unreachable] = findingsOf(res, "native/buffer.c", "dead-code/unreachable");
    expect(unreachable!.evidence).toBe("`written = -2;` at line 27 follows `return -1;` at line 26 in the same block and can never execute.");
  });

  it("never reports findings for test files, but still measures them", () => {
    expect(findingsOf(res, "tests/orders.test.ts")).toEqual([]);
    expect(metricsOf(res, "tests/orders.test.ts").functionCount).toBe(2);
    expect(res.summary.totals.testFiles).toBe(1);
  });

  it("summarises the run", () => {
    const s = res.summary;
    expect(s.totals).toMatchObject({ filesAnalyzed: 11, maxComplexity: 15, filesWithParseErrors: 0 });
    expect(s.totals.duplicationPercent).toBeGreaterThan(0);
    expect(s.hotspots[0]).toMatchObject({ path: "src/orders.ts", name: "processOrder", complexity: 15 });
    expect(s.findings.bySeverity).toMatchObject({ MEDIUM: 13, LOW: 8, INFO: 2 });
    expect(s.findings.byType["empty-catch"]).toBe(4);
    expect(s.parser).toHaveProperty("web-tree-sitter");
    expect(s.byLanguage.map((l) => l.language).sort()).toEqual(["c", "cpp", "java", "javascript", "python", "typescript"]);
  });
});

describe("analyzeCode edge cases", () => {
  it("classifies lines with mixed code, comments and multi-line strings", async () => {
    const res = await analyzeFiles({
      "src/a.js": ["/* header", "   comment */", "const s = `line one", "", "line three`; // trailing", "", "// only comment"].join("\n") + "\n",
    });
    // The blank line inside the template literal is code, not blank.
    expect(metricsOf(res, "src/a.js")).toMatchObject({ lines: 7, codeLines: 3, commentLines: 3, blankLines: 1 });
  });

  it("isolates nested function complexity from the enclosing function", async () => {
    const res = await analyzeFiles({
      "src/a.ts": "export function outer(x: number) {\n  const inner = (y: number) => (y > 0 && y < 10 ? 1 : 2);\n  if (x) return inner(x);\n  return 0;\n}\n",
    });
    const fns = metricsOf(res, "src/a.ts").functions;
    expect(fns.find((f) => f.name === "outer")?.complexity).toBe(2);
    expect(fns.find((f) => f.name === "outer.inner")?.complexity).toBe(3);
  });

  it("treats else-if chains as one nesting level in Java and C", async () => {
    const chain = (n: number) =>
      Array.from({ length: n }, (_, i) => `${i ? " else " : ""}if (x == ${i}) { y = ${i}; }`).join("");
    const res = await analyzeFiles({
      "src/A.java": `class A { int f(int x) { int y = 0; ${chain(8)} return y; } }\n`,
      "src/a.c": `int f(int x) { int y = 0; ${chain(8)} return y; }\n`,
    });
    expect(metricsOf(res, "src/A.java").maxNesting).toBe(1);
    expect(metricsOf(res, "src/a.c").maxNesting).toBe(1);
    expect(metricsOf(res, "src/a.c").maxComplexity).toBe(9);
  });

  it("uses character offsets correctly for non-ASCII source", async () => {
    const res = await analyzeFiles({
      "src/a.js": '// Grüße 😀 — ünïcode\nconst s = "日本語";\nimport { used, unused } from "m";\nused(s);\n',
    });
    const unused = findingsOf(res, "src/a.js", "dead-code/unused-import");
    expect(unused.map((f) => f.evidence)).toEqual([expect.stringContaining("`unused` is imported at line 3")]);
  });

  it("does not flag imports that are used implicitly or documented as used", async () => {
    const res = await analyzeFiles({
      "src/view.jsx": 'import React from "react";\nexport const V = () => <div />;\n',
      "src/types.ts": 'import type { Foo } from "./foo";\n/** Returns a {@link Foo}-shaped value. */\nexport const x = 1;\n',
      "src/Doc.java": "import java.util.List;\n/** See {@link List}. */\nclass Doc {}\n",
      "pkg/__init__.py": "from .core import run\n",
      "pkg/api.py": '__all__ = ["run"]\nfrom .core import run\nimport typing  # noqa: F401\nfrom .models import User\n\ndef get() -> "User":\n    return None\n',
    });
    expect(res.findings.filter((f) => f.ruleId === "dead-code/unused-import")).toEqual([]);
  });

  it("does not flag referenced static functions, including use in macros", async () => {
    const res = await analyzeFiles({
      "src/a.c": "static int helper(int x);\nstatic int helper(int x) { return x; }\nstatic int viaMacro(void) { return 1; }\n#define CALL() viaMacro()\nint main(void) { return helper(1) + CALL(); }\n",
    });
    expect(res.findings.filter((f) => f.ruleId === "dead-code/unused-private")).toEqual([]);
  });

  it("does not treat hoisted declarations or `break` after return as unreachable", async () => {
    const res = await analyzeFiles({
      "src/a.js": "function f(x) {\n  return g(x);\n  function g(y) { return y; }\n}\nfunction h(x) {\n  switch (x) {\n    case 1:\n      return 1;\n      break;\n  }\n}\n",
    });
    expect(res.findings.filter((f) => f.ruleId === "dead-code/unreachable")).toEqual([]);
  });

  it("allows documented empty catch blocks", async () => {
    const res = await analyzeFiles({
      "src/a.ts": "try { run(); } catch {\n  // optional feature; absence is fine\n}\n",
      "src/b.py": "try:\n    run()\nexcept ImportError:\n    # optional dependency\n    pass\n",
    });
    expect(res.findings.filter((f) => f.ruleId === "smell/empty-catch")).toEqual([]);
  });

  it("flags large files and god classes", async () => {
    const methods = Array.from({ length: 25 }, (_, i) => `  m${i}() {\n    return ${i};\n  }`).join("\n");
    const statements = Array.from({ length: 1100 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    const res = await analyzeFiles({ "src/Big.ts": `export class Big {\n${methods}\n}\n`, "src/consts.ts": `${statements}\n` });
    const [god] = findingsOf(res, "src/Big.ts", "smell/god-class");
    expect(god!.evidence).toContain("has 25 methods");
    const [large] = findingsOf(res, "src/consts.ts", "size/large-file");
    expect(large!.severity).toBe("MEDIUM");
    expect(large!.evidence).toContain("1100 lines of code (limit 500)");
  });

  it("grades long functions and parameter lists by severity", async () => {
    const body = Array.from({ length: 160 }, (_, i) => `  total += ${i};`).join("\n");
    const res = await analyzeFiles({
      "src/a.py": `def long_one(a, b, c, d, e, f, g, h):\n    total = 0\n${body.replace(/ {2}/g, "    ")}\n    return total\n`,
    });
    const rules = Object.fromEntries(findingsOf(res, "src/a.py").map((f) => [f.ruleId, f.severity]));
    expect(rules).toMatchObject({ "size/long-function": "HIGH", "smell/long-parameter-list": "MEDIUM" });
  });

  it("skips minified files instead of distorting metrics", async () => {
    const res = await analyzeFiles({ "src/vendor-lib.js": `var a=1;${"function x(){return 1};".repeat(400)}\n` });
    expect(res.files).toEqual([]);
    expect(res.summary.skipped).toEqual([{ path: "src/vendor-lib.js", reason: "minified" }]);
    expect(res.summary.totals.filesSkipped).toBe(1);
  });

  it("skips files whose parse exceeds the time budget", async () => {
    const big = Array.from({ length: 20_000 }, (_, i) => `const v${i} = [${i}, ${i + 1}, { k: ${i} }];`).join("\n");
    const res = await analyzeFiles({ "src/big.js": big }, { parseTimeoutMs: 0 });
    expect(res.summary.skipped).toEqual([{ path: "src/big.js", reason: "timeout" }]);
  });

  it("keeps fingerprints stable when code moves", async () => {
    const code = "export function f(a, b, c, d, e, f2, g) {\n  debugger;\n  return a;\n}\n";
    const before = await analyzeFiles({ "src/a.js": code });
    const after = await analyzeFiles({ "src/a.js": `// moved down\n\n\n${code}` });
    const prints = (r: CodeAnalysis) => r.findings.map((f: CodeFinding) => f.fingerprint).sort();
    expect(before.findings.length).toBe(2);
    expect(prints(after)).toEqual(prints(before));
    expect(after.findings[0]!.line).not.toBe(before.findings[0]!.line);
  });

  it("caps stored findings, keeping the most severe", async () => {
    const todos = Array.from({ length: 30 }, (_, i) => `// TODO item ${i}`).join("\n");
    const res = await analyzeFiles({ "src/a.js": `${todos}\nfunction f() {\n  return 1;\n  f();\n}\n` }, { maxFindings: 5 });
    expect(res.findings).toHaveLength(5);
    expect(res.findings[0]!.ruleId).toBe("dead-code/unreachable");
    // At most 20 TODOs are reported per file.
    expect(res.summary.findings).toMatchObject({ total: 21, stored: 5, truncated: true });
  });
});

describe("findDuplicates", () => {
  const stream = (tokens: number[], rowOf: (i: number) => number) => ({
    hashes: Int32Array.from(tokens),
    rows: Int32Array.from(tokens.map((_, i) => rowOf(i))),
  });
  const seq = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => i + offset);

  it("finds a clone across files and reports it once", () => {
    const shared = seq(80, 1000);
    const res = findDuplicates(
      [
        { path: "a", tokens: stream([...seq(10), ...shared], (i) => Math.floor(i / 5)) },
        { path: "b", tokens: stream([...seq(20, 500), ...shared, ...seq(5, 900)], (i) => Math.floor(i / 5)) },
      ],
      { minTokens: 50, minLines: 6, maxTokens: 1e6 },
    );
    expect(res.clones).toHaveLength(1);
    expect(res.clones[0]).toMatchObject({ tokens: 80, original: { path: "a", startLine: 3 }, duplicate: { path: "b", startLine: 5 } });
    expect(res.duplicatedLines.get("a")?.size).toBe(16);
  });

  it("ignores short matches and never reports overlapping self-matches", () => {
    const res = findDuplicates([{ path: "a", tokens: stream(Array(200).fill(7), (i) => Math.floor(i / 4)) }], {
      minTokens: 50,
      minLines: 6,
      maxTokens: 1e6,
    });
    for (const c of res.clones) expect(c.duplicate.startLine).toBeGreaterThan(c.original.endLine - 1);
    const none = findDuplicates(
      [
        { path: "a", tokens: stream(seq(40), (i) => i) },
        { path: "b", tokens: stream(seq(40), (i) => i) },
      ],
      { minTokens: 50, minLines: 6, maxTokens: 1e6 },
    );
    expect(none.clones).toEqual([]);
  });

  it("stops indexing at the token budget", () => {
    const res = findDuplicates(
      [
        { path: "a", tokens: stream(seq(100), (i) => i) },
        { path: "b", tokens: stream(seq(100), (i) => i) },
      ],
      { minTokens: 50, minLines: 6, maxTokens: 150 },
    );
    expect(res.truncated).toBe(true);
    expect(res.clones).toEqual([]);
  });
});

describe("redactSecrets", () => {
  it("masks credential-like values in evidence", () => {
    expect(redactSecrets('const password = "hunter2";')).toBe('const password = "<redacted>";');
    expect(redactSecrets("api_key: 'abc'")).toBe("api_key: '<redacted>'");
    expect(redactSecrets('headers = { x: "test_stripe_secret_key_placeholder" }')).toBe('headers = { x: "<redacted>" }');
    expect(redactSecrets('log("processing the order now")')).toBe('log("processing the order now")');
  });

  it("masks well-known token formats even outside quotes", () => {
    // Built at runtime so the repository never contains a string that looks like a real key.
    const stripe = ["sk", "live", "0".repeat(24)].join("_");
    const github = `ghp_${"A1".repeat(18)}`;
    const aws = `AKIA${"7".repeat(16)}`;
    expect(redactSecrets(`// rotate ${stripe} soon`)).toBe("// rotate <redacted> soon");
    expect(redactSecrets(`fetch(url, { token: ${github} })`)).toBe("fetch(url, { token: <redacted> })");
    expect(redactSecrets(`const id = "${aws}";`)).toBe('const id = "<redacted>";');
  });

  it("leaves ordinary long identifiers and prose alone", () => {
    expect(redactSecrets('emit("order_processing_completed_event")')).toBe('emit("order_processing_completed_event")');
    expect(redactSecrets("const total = computeInvoiceTotalWithDiscounts(order);")).toBe(
      "const total = computeInvoiceTotalWithDiscounts(order);",
    );
  });

  it("is applied to code excerpts in persisted evidence", async () => {
    const res = await analyzeFiles({
      "src/cfg.ts": `export function connect(a: number, b: number, c: number, d: number, e: number, password = "hunter2") {\n  return a + b + c + d + e + password.length;\n}\n`,
    });
    const [finding] = findingsOf(res, "src/cfg.ts", "smell/long-parameter-list");
    expect(finding?.evidence).toContain('password = "<redacted>"');
    expect(res.findings.some((f) => f.evidence.includes("hunter2"))).toBe(false);
  });
});

