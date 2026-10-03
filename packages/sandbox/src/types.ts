import type { TestSetup } from "./commands";

/** One command run in the sandbox, as stored (SandboxExecution) and shown. */
export interface ExecutionResult {
  kind: "INSTALL" | "TEST";
  commandId: string;
  command: string;
  image: string;
  network: boolean;
  /** Null when the command was killed at its time limit. */
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Redacted, sanitised, at most OUTPUT_LIMIT_BYTES. */
  output: string;
  outputTruncated: boolean;
}

export type SandboxStatus = { available: true; installEnabled: boolean } | { available: false; reason: string };

/** A prepared copy of one workspace. Always close it, also after errors. */
export interface SandboxSession {
  /** The network-enabled dependency install; throws when disabled or not part of the setup. */
  install(): Promise<ExecutionResult>;
  /** The test command, without network. */
  test(): Promise<ExecutionResult>;
  /** Removes every container and the volume of this session. */
  close(): Promise<void>;
}

export interface SandboxDriver {
  readonly name: string;
  status(): Promise<SandboxStatus>;
  /** Copies `workspaceDir` (without .git) into a fresh sandbox for `setup`. */
  open(runId: string, workspaceDir: string, setup: TestSetup): Promise<SandboxSession>;
}
