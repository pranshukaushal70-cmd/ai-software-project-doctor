import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { CommandSpec, TestSetup } from "./commands";
import type { SandboxConfig } from "./config";
import { sanitizeOutput, TailBuffer } from "./output";
import type { ExecutionResult, SandboxDriver, SandboxSession, SandboxStatus } from "./types";

/**
 * Runs repository code in disposable Docker containers. Every container:
 * - has no network (`--network none`), except the separately approved install step;
 * - has a read-only root filesystem, a small noexec /tmp and one writable volume
 *   (/work) that holds only a copy of the workspace (no host directory is mounted,
 *   no Docker socket, no .git directory);
 * - runs as an unprivileged user with every capability dropped, no-new-privileges,
 *   and limits on processes, memory (no swap), CPU and open files;
 * - gets only the environment variables its command template sets: nothing from
 *   the worker (no API keys, no database URL);
 * - is killed at its time limit and removed afterwards, with the volume.
 * The workspace is copied in as root-owned files, so a one-off container that
 * runs only the image's `chown` (as root with CAP_CHOWN alone, no network) hands
 * /work to the unprivileged user first.
 */

export interface DockerExecResult {
  code: number | null;
  output: string;
  /** Output beyond the buffer was dropped (the tail is kept). */
  dropped: boolean;
  timedOut: boolean;
}

/** Runs the docker CLI; injectable so tests can assert the exact arguments without Docker. */
export type DockerExec = (args: string[], opts: { timeoutMs: number }) => Promise<DockerExecResult>;

export const SANDBOX_USER = "1000:1000";
const WORKDIR = "/work";
const HOUSEKEEPING_TIMEOUT_MS = 120_000;

/** The docker CLI on the host needs a few variables to find its daemon and config; none of them reach a container. */
const CLI_ENV_KEYS = ["PATH", "Path", "SystemRoot", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "ProgramData", "TEMP", "TMP", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"];

export const execDocker: DockerExec = (args, opts) =>
  new Promise((resolve, reject) => {
    const env = Object.fromEntries(CLI_ENV_KEYS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!]));
    const child = spawn("docker", args, { env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const buf = new TailBuffer();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => buf.push(d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => buf.push(d.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: buf.text(), dropped: buf.dropped, timedOut });
    });
  });

export interface ContainerSpec {
  name: string;
  runLabel: string;
  volume: string;
  image: string;
  argv: string[];
  env: Record<string, string>;
  network: boolean;
  /** "root" only for the ownership hand-over, which gets CAP_CHOWN and nothing else. */
  user: "sandbox" | "root";
}

/** `docker create` arguments for one sandbox container. Every isolation flag is set here and nowhere else. */
export function containerArgs(spec: ContainerSpec, config: Pick<SandboxConfig, "memoryMb" | "cpus" | "pids" | "runtime">): string[] {
  const args = [
    "create",
    "--name", spec.name,
    "--label", "pd.sandbox=1",
    "--label", `pd.run=${spec.runLabel}`,
    "--network", spec.network ? "bridge" : "none",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=512m",
    "--mount", `type=volume,source=${spec.volume},target=${WORKDIR}`,
    "--workdir", WORKDIR,
    "--user", spec.user === "root" ? "0:0" : SANDBOX_USER,
    "--cap-drop", "ALL",
    ...(spec.user === "root" ? ["--cap-add", "CHOWN"] : []),
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(config.pids),
    "--memory", `${config.memoryMb}m`,
    "--memory-swap", `${config.memoryMb}m`,
    "--cpus", String(config.cpus),
    "--ulimit", "nofile=4096:4096",
    "--ulimit", "core=0",
    "--hostname", "sandbox",
    "--pull", "missing",
    ...(config.runtime === "runsc" ? ["--runtime", "runsc"] : []),
    ...Object.entries(spec.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    "--entrypoint", spec.argv[0]!,
    spec.image,
    ...spec.argv.slice(1),
  ];
  return args;
}

const safeLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32) || "run";

export class DockerSandbox implements SandboxDriver {
  readonly name = "docker";
  constructor(
    private readonly config: SandboxConfig,
    private readonly docker: DockerExec = execDocker,
  ) {}

  async status(): Promise<SandboxStatus> {
    const r = await this.docker(["version", "--format", "{{.Server.Os}}"], { timeoutMs: 15_000 }).catch(() => null);
    if (!r || r.code !== 0) return { available: false, reason: "Docker is not reachable from the worker." };
    if (r.output.trim() !== "linux") return { available: false, reason: "The Docker engine must run Linux containers." };
    return { available: true, installEnabled: this.config.installEnabled };
  }

  async open(runId: string, workspaceDir: string, setup: TestSetup): Promise<SandboxSession> {
    const label = safeLabel(runId);
    const id = `pd-sbx-${label}-${randomBytes(4).toString("hex")}`;
    const volume = `${id}-work`;
    const docker = this.docker;
    const config = this.config;
    let containers = 0;

    const must = async (args: string[], what: string, timeoutMs = HOUSEKEEPING_TIMEOUT_MS) => {
      const r = await docker(args, { timeoutMs });
      if (r.code !== 0 || r.timedOut) throw new Error(`sandbox ${what} failed`);
      return r;
    };
    const close = async () => {
      await docker(["rm", "-f", ...Array.from({ length: containers }, (_, i) => `${id}-${i}`)], { timeoutMs: HOUSEKEEPING_TIMEOUT_MS }).catch(() => undefined);
      await docker(["volume", "rm", "-f", volume], { timeoutMs: HOUSEKEEPING_TIMEOUT_MS }).catch(() => undefined);
    };

    /** Creates, runs and removes one container; returns its outcome. */
    const step = async (s: Omit<ContainerSpec, "name" | "runLabel" | "volume">, timeoutMs: number, beforeStart?: (name: string) => Promise<void>) => {
      const name = `${id}-${containers++}`;
      const started = performance.now();
      try {
        await must(containerArgs({ ...s, name, runLabel: label, volume }, config), "container creation");
        await beforeStart?.(name);
        const run = await docker(["start", "--attach", name], { timeoutMs });
        let exitCode: number | null = null;
        if (run.timedOut) await docker(["kill", name], { timeoutMs: 30_000 }).catch(() => undefined);
        else {
          const inspected = await docker(["inspect", "--format", "{{.State.ExitCode}}", name], { timeoutMs: 30_000 });
          const n = Number.parseInt(inspected.output.trim(), 10);
          exitCode = inspected.code === 0 && Number.isFinite(n) ? n : run.code;
        }
        return { run, exitCode, durationMs: Math.round(performance.now() - started) };
      } finally {
        await docker(["rm", "-f", name], { timeoutMs: HOUSEKEEPING_TIMEOUT_MS }).catch(() => undefined);
      }
    };

    const execute = async (kind: ExecutionResult["kind"], cmd: CommandSpec, network: boolean, timeoutMs: number): Promise<ExecutionResult> => {
      const { run, exitCode, durationMs } = await step({ image: setup.image, argv: cmd.argv, env: cmd.env, network, user: "sandbox" }, timeoutMs);
      const { output, truncated } = sanitizeOutput(run.output, run.dropped);
      return { kind, commandId: cmd.id, command: cmd.display, image: setup.image, network, exitCode: run.timedOut ? null : exitCode, timedOut: run.timedOut, durationMs, output, outputTruncated: truncated };
    };

    try {
      await must(["volume", "create", "--label", "pd.sandbox=1", "--label", `pd.run=${label}`, volume], "volume creation");
      // Copy the workspace into the volume through a container that only changes ownership.
      const entries = (await readdir(workspaceDir)).filter((e) => e !== ".git");
      const prep = await step({ image: setup.image, argv: ["chown", "-R", SANDBOX_USER, WORKDIR], env: {}, network: false, user: "root" }, HOUSEKEEPING_TIMEOUT_MS, async (name) => {
        for (const e of entries) await must(["cp", path.join(workspaceDir, e), `${name}:${WORKDIR}/`], "workspace copy");
      });
      if (prep.exitCode !== 0) throw new Error("sandbox preparation failed");
    } catch (err) {
      await close();
      throw err;
    }

    return {
      install: async () => {
        if (!config.installEnabled) throw new Error("The dependency install step is disabled (SANDBOX_INSTALL_ENABLED=false).");
        if (!setup.install) throw new Error("This test setup has no install step.");
        return execute("INSTALL", setup.install, true, config.installTimeoutMs);
      },
      test: () => execute("TEST", setup.test, false, config.testTimeoutMs),
      close,
    };
  }
}
