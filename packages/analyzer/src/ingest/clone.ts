import { spawn } from "node:child_process";
import { lstat, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError, parseRepositoryUrl } from "@pd/shared";

export interface CloneOptions {
  url: string;
  branch?: string;
  destDir: string;
  depth: number;
  timeoutMs: number;
}

export interface CloneResult {
  dir: string;
  commitSha: string;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Killed because `signal` was aborted (e.g. a size limit was exceeded). */
  aborted: boolean;
}

/**
 * Git for Windows cannot open Node's `os.devNull` ("\\.\nul") but special-cases the
 * literal "/dev/null" on every platform.
 */
const GIT_NULL = "/dev/null";

/**
 * Configuration applied to every git invocation. The repository is untrusted:
 * no hooks, no submodules, no LFS smudge, no symlinks, and only the https
 * transport is permitted (blocks file://, ext::, ssh redirects).
 */
const HARDENED_CONFIG = [
  `core.hooksPath=${GIT_NULL}`,
  "core.symlinks=false",
  "core.fsmonitor=false",
  "core.protectNTFS=true",
  "core.protectHFS=true",
  "core.longpaths=true",
  "protocol.allow=never",
  "protocol.https.allow=always",
  "submodule.recurse=false",
  "credential.helper=",
  "filter.lfs.smudge=",
  "filter.lfs.process=",
  "filter.lfs.required=false",
];

/** A minimal environment: nothing from the parent process leaks into git except what it needs. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot, // required by git on Windows
    HOME: os.tmpdir(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    SSH_ASKPASS: "",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: GIT_NULL,
  };
  return env as NodeJS.ProcessEnv;
}

export function runGit(args: string[], opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal }): Promise<RunResult> {
  const fullArgs = HARDENED_CONFIG.flatMap((c) => ["-c", c]).concat(args);
  const isWindows = process.platform === "win32";
  return new Promise((resolve, reject) => {
    // On POSIX git gets its own process group so a timeout can kill its helpers
    // (git-remote-https, …) too; on Windows taskkill /T does the same.
    const child = spawn("git", fullArgs, { cwd: opts.cwd, env: gitEnv(), windowsHide: true, shell: false, detached: !isWindows });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid, () => child.kill("SIGKILL"));
    }, opts.timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child.pid, () => child.kill("SIGKILL"));
    };
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    // A helper process that survives the kill keeps stdout/stderr open, so after a
    // timeout 'close' may never come: settle on 'exit' of git itself instead.
    child.on("exit", (code) => {
      if (timedOut || aborted) finish(code);
    });
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < 50 * 1024 * 1024) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", finish);
  });
}

/**
 * Best-effort kill of a process and all of its descendants. `fallback` kills
 * the direct child; on Windows it runs only after taskkill has walked the tree,
 * otherwise the helpers would be orphaned before taskkill could find them.
 */
function killTree(pid: number | undefined, fallback: () => void) {
  if (pid === undefined) return fallback();
  if (process.platform === "win32") {
    const tk = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    tk.on("error", fallback);
    tk.on("exit", fallback);
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Process group already gone.
  }
  fallback();
}

/**
 * Shallow-clone a public repository. The URL is re-validated here so this
 * function is safe to call even if a caller forgot to validate.
 */
export async function cloneRepository(opts: CloneOptions): Promise<CloneResult> {
  const parsed = parseRepositoryUrl(opts.url);
  const branch = opts.branch ?? parsed.branch;
  const dir = path.resolve(opts.destDir, "repo");

  const args = ["clone", "--no-tags", "--single-branch", `--depth=${Math.max(1, Math.floor(opts.depth))}`];
  if (branch) args.push(`--branch=${branch}`);
  args.push("--", parsed.cloneUrl, dir);

  const result = await runGit(args, { cwd: opts.destDir, timeoutMs: opts.timeoutMs });
  if (result.timedOut) {
    throw new AppError("CLONE_FAILED", `Cloning timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
  }
  if (result.code !== 0) {
    throw new AppError("CLONE_FAILED", describeCloneFailure(result.stderr), {
      details: { gitExitCode: result.code },
    });
  }

  const rev = await runGit(["rev-parse", "HEAD"], { cwd: dir, timeoutMs: 10_000 });
  return { dir, commitSha: rev.stdout.trim() };
}

export function describeCloneFailure(stderr: string): string {
  if (/Remote branch .* not found/i.test(stderr)) return "The requested branch does not exist";
  if (/not found|could not read Username|Authentication failed|terminal prompts disabled/i.test(stderr)) {
    return "Repository not found or not public";
  }
  if (/Could not resolve host|unable to access/i.test(stderr)) return "Could not reach the repository host";
  return "Repository could not be cloned";
}

// ---------------------------------------------------------------- fetch one commit (code engine, Phase 8)

export interface FetchCommitOptions {
  url: string;
  /** Full commit id (40 hex characters, or 64 for SHA-256 repositories). */
  commitSha: string;
  destDir: string;
  timeoutMs: number;
  /** Disk space the fetched repository (objects and checked-out files) may use. */
  maxBytes: number;
}

const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SIZE_POLL_MS = 1000;

/**
 * Re-creates the working tree of exactly one commit of a public repository: the
 * commit an analysis was made from, so the code engine edits what was analysed and
 * not whatever the branch points to now. Same hardened git configuration as
 * cloneRepository (no hooks, no submodules, no LFS, https only); only that commit
 * is fetched (depth 1). The repository's size on disk is watched while git runs,
 * and git is killed as soon as it exceeds `maxBytes`.
 */
export async function fetchCommit(opts: FetchCommitOptions): Promise<CloneResult> {
  const parsed = parseRepositoryUrl(opts.url);
  if (!COMMIT_SHA.test(opts.commitSha)) throw new AppError("VALIDATION_ERROR", "Invalid commit id");
  const dir = path.resolve(opts.destDir, "repo");
  await mkdir(dir, { recursive: true });
  const deadline = Date.now() + opts.timeoutMs;
  const remaining = () => Math.max(1, deadline - Date.now());

  const watcher = watchDirectorySize(dir, opts.maxBytes);
  try {
    const steps: string[][] = [
      // No template directory: nothing (not even sample hooks) is copied into the repository.
      ["init", "--quiet", "--template=", "--", dir],
      ["fetch", "--quiet", "--no-tags", "--depth=1", "--", parsed.cloneUrl, opts.commitSha],
      ["checkout", "--quiet", "--detach", "FETCH_HEAD"],
    ];
    for (const args of steps) {
      const result = await runGit(args, { cwd: dir, timeoutMs: remaining(), signal: watcher.signal });
      if (result.aborted) throw new AppError("CLONE_FAILED", `The repository exceeds the ${Math.round(opts.maxBytes / 1024 / 1024)} MB size limit`);
      if (result.timedOut) throw new AppError("CLONE_FAILED", `Fetching the repository timed out after ${Math.round(opts.timeoutMs / 1000)}s`);
      if (result.code !== 0) throw new AppError("CLONE_FAILED", describeFetchFailure(result.stderr), { details: { gitExitCode: result.code } });
    }
  } finally {
    watcher.stop();
  }
  // The watcher polls; a fetch that finished between two polls is measured once more.
  if ((await directorySize(dir)) > opts.maxBytes) throw new AppError("CLONE_FAILED", `The repository exceeds the ${Math.round(opts.maxBytes / 1024 / 1024)} MB size limit`);
  const rev = await runGit(["rev-parse", "HEAD"], { cwd: dir, timeoutMs: 10_000 });
  if (rev.stdout.trim() !== opts.commitSha) throw new AppError("CLONE_FAILED", "The fetched commit does not match the analysed commit");
  return { dir, commitSha: opts.commitSha };
}

export function describeFetchFailure(stderr: string): string {
  // The commit was force-pushed away or garbage-collected upstream.
  if (/not our ref|couldn't find remote ref|unadvertised object|no such remote ref|reference is not a tree/i.test(stderr)) {
    return "The analysed commit is no longer available from the repository; run a new analysis";
  }
  return describeCloneFailure(stderr);
}

/** Total size of the regular files under `dir` (symlinks are not followed). */
export async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const pending = [dir];
  while (pending.length) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isDirectory()) pending.push(full);
      else if (e.isFile()) total += (await lstat(full).catch(() => null))?.size ?? 0;
    }
  }
  return total;
}

/** Aborts `signal` as soon as `dir` grows beyond `maxBytes`; polled while git runs. */
export function watchDirectorySize(dir: string, maxBytes: number, intervalMs = SIZE_POLL_MS): { signal: AbortSignal; stop(): void } {
  const controller = new AbortController();
  let busy = false;
  const timer = setInterval(() => {
    if (busy || controller.signal.aborted) return;
    busy = true;
    directorySize(dir)
      .then((size) => {
        if (size > maxBytes) controller.abort();
      })
      .finally(() => (busy = false));
  }, intervalMs);
  timer.unref?.();
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}
