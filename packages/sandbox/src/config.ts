import { z } from "zod";

/**
 * Sandbox configuration (Phase 8). Everything is off by default: with
 * SANDBOX_ENABLED unset, no repository code ever runs and a run ends with its diff
 * for review. The network-enabled dependency install is a separate switch, also
 * off by default. Images must be pinned by digest, so what runs cannot change
 * under a tag.
 */

/** `name[:tag]@sha256:<64 hex>`: a tag alone is refused. */
export const PINNED_IMAGE = /^[a-z0-9][a-z0-9._\/-]*(?::[\w][\w.-]{0,127})?@sha256:[a-f0-9]{64}$/;

/** Defaults: the multi-architecture digests pulled and verified on 2026-10-03; override with SANDBOX_IMAGE_*. */
export const DEFAULT_IMAGES = {
  node: "node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6",
  python: "python:3.12-slim@sha256:dddfd7e07f9d15aeeca61529320492139d21cac7f0070c00609243e51e4e0016",
} as const;

const bool = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");
const int = (def: number, max: number) => z.coerce.number().int().positive().max(max).default(def);
const image = (def: string) => z.string().regex(PINNED_IMAGE, "Sandbox images must be pinned by digest (name:tag@sha256:…)").default(def);

const schema = z.object({
  SANDBOX_ENABLED: bool,
  SANDBOX_INSTALL_ENABLED: bool,
  SANDBOX_RUNTIME: z.enum(["runc", "runsc"]).default("runc"),
  SANDBOX_IMAGE_NODE: image(DEFAULT_IMAGES.node),
  SANDBOX_IMAGE_PYTHON: image(DEFAULT_IMAGES.python),
  SANDBOX_TIMEOUT_SECONDS: int(300, 3600),
  SANDBOX_INSTALL_TIMEOUT_SECONDS: int(300, 3600),
  SANDBOX_MEMORY_MB: int(1024, 16384),
  SANDBOX_CPUS: int(1, 16),
  SANDBOX_PIDS: int(256, 4096),
});

export interface SandboxConfig {
  /** Run tests in containers at all. */
  enabled: boolean;
  /** Allow the separate, network-enabled dependency install step. */
  installEnabled: boolean;
  /** Container runtime; "runsc" is gVisor, if installed. */
  runtime: "runc" | "runsc";
  images: { node: string; python: string };
  testTimeoutMs: number;
  installTimeoutMs: number;
  memoryMb: number;
  cpus: number;
  pids: number;
}

export function loadSandboxConfig(env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const c = schema.parse(Object.fromEntries(Object.entries(env).filter(([k, v]) => k.startsWith("SANDBOX_") && v !== undefined && v !== "")));
  return {
    enabled: c.SANDBOX_ENABLED,
    installEnabled: c.SANDBOX_INSTALL_ENABLED,
    runtime: c.SANDBOX_RUNTIME,
    images: { node: c.SANDBOX_IMAGE_NODE, python: c.SANDBOX_IMAGE_PYTHON },
    testTimeoutMs: c.SANDBOX_TIMEOUT_SECONDS * 1000,
    installTimeoutMs: c.SANDBOX_INSTALL_TIMEOUT_SECONDS * 1000,
    memoryMb: c.SANDBOX_MEMORY_MB,
    cpus: c.SANDBOX_CPUS,
    pids: c.SANDBOX_PIDS,
  };
}
