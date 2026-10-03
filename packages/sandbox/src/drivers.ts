import type { TestSetup } from "./commands";
import type { SandboxConfig } from "./config";
import { DockerSandbox, type DockerExec } from "./docker";
import type { ExecutionResult, SandboxDriver, SandboxSession, SandboxStatus } from "./types";

/** The default: no repository code runs. A run then ends with its diff for review, tests not run. */
export class DisabledSandbox implements SandboxDriver {
  readonly name = "disabled";
  async status(): Promise<SandboxStatus> {
    return { available: false, reason: "Sandboxed test runs are disabled on this server (SANDBOX_ENABLED=false)." };
  }
  async open(): Promise<SandboxSession> {
    throw new Error("Sandboxed test runs are disabled (SANDBOX_ENABLED=false).");
  }
}

/** Scripted results for tests: no container, nothing executed. Records every call. */
export class FakeSandbox implements SandboxDriver {
  readonly name = "fake";
  readonly opened: Array<{ runId: string; workspaceDir: string; setup: TestSetup }> = [];
  readonly calls: Array<"install" | "test" | "close"> = [];
  /** Scripted test results, consumed across sessions in order (the last one repeats). */
  private readonly tests: Array<Partial<ExecutionResult>>;
  constructor(
    private readonly script: { install?: Partial<ExecutionResult>; test?: Array<Partial<ExecutionResult>> } = {},
    private readonly opts: { installEnabled?: boolean; unavailable?: string } = {},
  ) {
    this.tests = [...(script.test ?? [])];
  }

  async status(): Promise<SandboxStatus> {
    return this.opts.unavailable ? { available: false, reason: this.opts.unavailable } : { available: true, installEnabled: this.opts.installEnabled ?? false };
  }

  async open(runId: string, workspaceDir: string, setup: TestSetup): Promise<SandboxSession> {
    this.opened.push({ runId, workspaceDir, setup });
    const result = (kind: ExecutionResult["kind"], over: Partial<ExecutionResult> = {}): ExecutionResult => {
      const cmd = kind === "INSTALL" ? setup.install! : setup.test;
      return { kind, commandId: cmd.id, command: cmd.display, image: setup.image, network: kind === "INSTALL", exitCode: 0, timedOut: false, durationMs: 10, output: "", outputTruncated: false, ...over };
    };
    const tests = this.tests;
    return {
      install: async () => {
        this.calls.push("install");
        if (!this.opts.installEnabled) throw new Error("The dependency install step is disabled (SANDBOX_INSTALL_ENABLED=false).");
        return result("INSTALL", this.script.install);
      },
      test: async () => {
        this.calls.push("test");
        return result("TEST", tests.length > 1 ? tests.shift() : tests[0]);
      },
      close: async () => void this.calls.push("close"),
    };
  }
}

/** The configured driver: Docker when SANDBOX_ENABLED, otherwise the disabled driver. */
export function createSandbox(config: SandboxConfig, docker?: DockerExec): SandboxDriver {
  return config.enabled ? new DockerSandbox(config, docker) : new DisabledSandbox();
}
