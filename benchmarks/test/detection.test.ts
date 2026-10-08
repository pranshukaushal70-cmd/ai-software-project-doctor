import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDetection } from "../src/detection";
import { loadFixtures } from "../src/ground-truth";
import { detectionMarkdown } from "../src/report";

// The detection benchmark is deterministic: a change in analyzer behaviour must show up as a
// reviewed change of the committed results (npm run bench:detection -- --write), not silently.

describe("detection benchmark", () => {
  it("every fixture's ground truth is valid and names files that exist", async () => {
    const fixtures = await loadFixtures();
    expect(fixtures.map((f) => f.truth.name)).toEqual(["clean-lib", "py-inventory", "storefront", "ts-billing"]);
    for (const f of fixtures) {
      const renamed = new Map(Object.entries(f.truth.source.rename ?? {}).map(([from, to]) => [to, from]));
      for (const issue of [...f.truth.expected, ...f.truth.acceptable]) {
        for (const p of issue.paths ?? (issue.path ? [issue.path] : [])) await access(path.join(f.sourceDir, renamed.get(p) ?? p));
      }
      for (const t of f.truth.tasks) for (const p of t.expectedFiles) await access(path.join(f.sourceDir, p));
    }
  });

  it("reproduces the committed results exactly", async () => {
    const result = await runDetection(await loadFixtures());
    const committed = JSON.parse(await readFile(new URL("../results/detection.json", import.meta.url), "utf8"));
    expect(result).toEqual(committed);
    const md = (await readFile(new URL("../results/detection.md", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
    expect(detectionMarkdown(result)).toBe(md);
  });
});
