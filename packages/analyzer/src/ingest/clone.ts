import { spawn } from "node:child_process";
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

export function runGit(args: string[], opts: { cwd?: string; timeoutMs: number }): Promise<RunResult> {
  const fullArgs = HARDENED_CONFIG.flatMap((c) => ["-c", c]).concat(args);
  return new Promise((resolve, reject) => {
    const child = spawn("git", fullArgs, { cwd: opts.cwd, env: gitEnv(), windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < 50 * 1024 * 1024) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
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
