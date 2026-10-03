import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cloneRepository, describeCloneFailure, describeFetchFailure, directorySize, fetchCommit, runGit, watchDirectorySize } from "../src/ingest/clone";

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

describe("fetchCommit", () => {
  const SHA = "a".repeat(40);
  it("validates the URL and the commit id before running git or creating anything", async () => {
    const dest = path.join(os.tmpdir(), `pd-fetch-never-${Date.now()}`);
    const opts = { destDir: dest, timeoutMs: 1000, maxBytes: 1024 };
    await expect(fetchCommit({ ...opts, url: "file:///etc", commitSha: SHA })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(fetchCommit({ ...opts, url: "https://internal.corp/o/r", commitSha: SHA })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    for (const bad of ["HEAD", "main", "abc123", `--upload-pack=x${"a".repeat(30)}`, "A".repeat(40), `${SHA} `]) {
      await expect(fetchCommit({ ...opts, url: "https://github.com/o/r", commitSha: bad })).rejects.toMatchObject({ code: "VALIDATION_ERROR", message: "Invalid commit id" });
    }
    await expect(directorySize(dest)).resolves.toBe(0); // nothing was created
  });

  it.each([
    ["fatal: remote error: upload-pack: not our ref aaaa", "The analysed commit is no longer available from the repository; run a new analysis"],
    ["fatal: couldn't find remote ref aaaa", "The analysed commit is no longer available from the repository; run a new analysis"],
    ["remote: Repository not found.\nfatal: repository 'x' not found", "Repository not found or not public"],
    ["fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com", "Could not reach the repository host"],
  ])("maps git stderr to a user-safe message", (stderr, expected) => {
    expect(describeFetchFailure(stderr)).toBe(expected);
  });
});

describe("size limit", () => {
  it("measures regular files recursively", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pd-size-"));
    try {
      await mkdir(path.join(dir, "a/b"), { recursive: true });
      await writeFile(path.join(dir, "x"), Buffer.alloc(100));
      await writeFile(path.join(dir, "a/b/y"), Buffer.alloc(250));
      expect(await directorySize(dir)).toBe(350);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("aborts as soon as the directory grows beyond the limit", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pd-size-"));
    const watcher = watchDirectorySize(dir, 1000, 20);
    try {
      await writeFile(path.join(dir, "small"), Buffer.alloc(500));
      await new Promise((r) => setTimeout(r, 100));
      expect(watcher.signal.aborted).toBe(false);
      await writeFile(path.join(dir, "big"), Buffer.alloc(800));
      await new Promise((r) => setTimeout(r, 200));
      expect(watcher.signal.aborted).toBe(true);
    } finally {
      watcher.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("kills git and its helpers when the signal aborts", async () => {
    const controller = new AbortController();
    const started = performance.now();
    setTimeout(() => controller.abort(), 300);
    const res = await runGit(["-c", "alias.stall=!sleep 20", "stall"], { timeoutMs: 20_000, signal: controller.signal });
    expect(res).toMatchObject({ aborted: true, timedOut: false });
    expect(performance.now() - started).toBeLessThan(8_000);
  }, 30_000);
});
