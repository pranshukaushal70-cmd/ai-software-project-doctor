import { describe, expect, it } from "vitest";
import { cloneRepository, describeCloneFailure, runGit } from "../src/ingest/clone";

describe("describeCloneFailure", () => {
  it.each([
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled\n", "Repository not found or not public"],
    ["remote: Repository not found.\nfatal: repository 'x' not found", "Repository not found or not public"],
    ["warning: Could not find remote branch nope to clone.\nfatal: Remote branch nope not found in upstream origin", "The requested branch does not exist"],
    ["fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com", "Could not reach the repository host"],
    ["fatal: something unexpected", "Repository could not be cloned"],
  ])("maps git stderr to a user-safe message", (stderr, expected) => {
    expect(describeCloneFailure(stderr)).toBe(expected);
  });
});

describe("cloneRepository", () => {
  it("re-validates URLs and refuses non-https or foreign hosts before running git", async () => {
    await expect(cloneRepository({ url: "file:///etc", destDir: ".", depth: 1, timeoutMs: 1000 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(cloneRepository({ url: "https://internal.corp/o/r", destDir: ".", depth: 1, timeoutMs: 1000 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("runGit", () => {
  it("enforces the timeout even when a git helper process keeps the output pipes open", async () => {
    // A shell alias makes git spawn a long-running child, like git-remote-https on a stalled clone.
    const started = performance.now();
    const res = await runGit(["-c", "alias.stall=!sleep 20", "stall"], { timeoutMs: 500 });
    expect(res.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(8_000);
  }, 30_000);
});
