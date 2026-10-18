import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(import.meta.dirname, "../app/globals.css"), "utf8");
const block = (start: string) => {
  const i = css.indexOf(start);
  expect(i, `${start} exists`).toBeGreaterThan(-1);
  let depth = 0;
  for (let j = css.indexOf("{", i); j < css.length; j++) {
    if (css[j] === "{") depth++;
    if (css[j] === "}" && --depth === 0) return css.slice(i, j + 1);
  }
  throw new Error(`unclosed ${start}`);
};

describe("scroll reveal is a progressive enhancement", () => {
  it("only moves content, never hides it", () => {
    const keyframes = block("@keyframes reveal-up");
    expect(keyframes).toContain("transform");
    expect(keyframes).not.toMatch(/opacity|visibility|display|clip/);
  });

  it("runs only without reduced motion and where scroll-driven animations exist", () => {
    const utility = block("@utility reveal");
    expect(utility).toContain("prefers-reduced-motion: no-preference");
    expect(utility).toContain("@supports (animation-timeline: view())");
    expect(utility).toContain("reveal-up");
  });
});
