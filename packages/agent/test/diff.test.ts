import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffLines, splitLines, unifiedDiff } from "../src/diff";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "pd-diff-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

let seq = 0;
/** Applies the patch with git (the oracle) to `before` and returns the result; null for a deleted file. */
async function gitApply(file: string, before: string | null, patch: string): Promise<string | null> {
  const work = path.join(dir, `case${++seq}`);
  await mkdir(path.join(work, path.dirname(file)), { recursive: true });
  if (before !== null) await writeFile(path.join(work, file), before);
  await writeFile(path.join(work, "change.patch"), patch);
  // --unidiff-zero is not used: hunks must carry proper context, as in a real download.
  const res = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--whitespace=nowarn", "change.patch"], { cwd: work, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git apply failed: ${res.stderr}\n${patch}`);
  return readFile(path.join(work, file), "utf8").catch(() => null);
}

async function roundTrip(before: string | null, after: string | null, file = "src/a.ts") {
  const d = unifiedDiff(file, before, after);
  // An empty diff means nothing changed; git refuses empty patches.
  if (d.diff === "") expect(after).toBe(before);
  else expect(await gitApply(file, before, d.diff)).toBe(after);
  return d;
}

describe("unifiedDiff", () => {
  it("produces git patches that reproduce the change exactly", async () => {
    const base = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join("");
    const lines = splitLines(base);
    const edited = [...lines];
    edited[2] = "changed 3\n";
    edited.splice(20, 2, "replaced 21\n", "replaced 22\n", "added\n");
    edited.push("appended\n");
    const d = await roundTrip(base, edited.join(""));
    expect(d.diff).toMatch(/^diff --git a\/src\/a\.ts b\/src\/a\.ts\n--- a\/src\/a\.ts\n\+\+\+ b\/src\/a\.ts\n@@ -1,6 \+1,6 @@/);
    expect(d.diff.match(/^@@/gm)).toHaveLength(3);
    expect({ additions: d.additions, deletions: d.deletions }).toEqual({ additions: 5, deletions: 3 });
  });

  it("handles new, deleted and emptied files", async () => {
    const created = await roundTrip(null, "export const a = 1;\nexport const b = 2;\n", "src/new.ts");
    expect(created.diff).toContain("new file mode 100644\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@");
    const deleted = await roundTrip("x\ny\n", null, "src/old.ts");
    expect(deleted.diff).toContain("deleted file mode 100644\n--- a/src/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@");
    await roundTrip("a\nb\n", "");
    await roundTrip("", "a\n");
  });

  it("marks missing final newlines and keeps CRLF line endings", async () => {
    const d = await roundTrip("a\nb", "a\nc");
    expect(d.diff).toContain("-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n");
    await roundTrip("a\nb", "a\nb\n");
    await roundTrip("a\nb\n", "a\nb");
    await roundTrip("one\r\ntwo\r\nthree\r\n", "one\r\n2\r\nthree\r\n");
  });

  it("returns an empty diff when nothing changed", () => {
    expect(unifiedDiff("a.ts", "same\n", "same\n")).toEqual({ diff: "", additions: 0, deletions: 0 });
  });

  it("matches git on random edits", async () => {
    // Deterministic pseudo-random cases (no Math.random: failures must reproduce).
    let state = 42;
    const rand = (n: number) => ((state = (state * 1103515245 + 12345) % 2 ** 31), state % n);
    for (let t = 0; t < 40; t++) {
      const before = Array.from({ length: rand(30) }, () => `v${rand(6)}\n`);
      const after = [...before];
      for (let e = rand(6); e > 0; e--) {
        const at = rand(after.length + 1);
        if (rand(2) && after.length) after.splice(at, 1);
        else after.splice(at, 0, `n${rand(6)}\n`);
      }
      await roundTrip(before.join(""), after.join(""));
    }
  }, 60_000);

  it("stays correct and bounded on a complete rewrite of a large file", async () => {
    const before = Array.from({ length: 6000 }, (_, i) => `old ${i}\n`).join("");
    const after = Array.from({ length: 6000 }, (_, i) => `new ${i}\n`).join("");
    const started = performance.now();
    const d = await roundTrip(before, after);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect({ additions: d.additions, deletions: d.deletions }).toEqual({ additions: 6000, deletions: 6000 });
  }, 30_000);

  it("diffLines keeps every line of both sides in order", () => {
    const a = ["a\n", "b\n", "c\n", "d\n"];
    const b = ["a\n", "c\n", "x\n", "d\n"];
    const ops = diffLines(a, b);
    expect(ops.filter((o) => o.kind !== "+").map((o) => o.line)).toEqual(a);
    expect(ops.filter((o) => o.kind !== "-").map((o) => o.line)).toEqual(b);
  });
});
