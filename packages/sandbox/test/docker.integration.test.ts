import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerSandbox, loadSandboxConfig, type TestSetup } from "../src";

/**
 * Runs real containers. Opt-in (PD_DOCKER_TESTS=1) because it needs a Docker
 * engine and the pinned images; the default suite never touches Docker.
 */
const enabled = process.env.PD_DOCKER_TESTS === "1";

/** Reports what the sandboxed process can and cannot do, then exits with code 7. */
const PROBE = `
const fs = require("fs");
const os = require("os");
const tryWrite = (p) => { try { fs.writeFileSync(p, "x"); return true; } catch { return false; } };
const result = {
  uid: process.getuid(),
  interfaces: Object.keys(os.networkInterfaces()).sort(),
  rootWritable: tryWrite("/usr/pd-probe"),
  tmpWritable: tryWrite("/tmp/pd-probe"),
  workWritable: tryWrite("/work/pd-probe"),
  dockerSocket: fs.existsSync("/var/run/docker.sock"),
  gitDir: fs.existsSync("/work/.git"),
  canary: process.env.PD_HOST_CANARY ?? null,
  hostKeys: Object.keys(process.env).filter((k) => /ANTHROPIC|DATABASE|REDIS|JWT|SECRET|TOKEN/i.test(k)),
  hostname: os.hostname(),
};
console.log("PROBE " + JSON.stringify(result));
process.exit(7);
`;

describe.skipIf(!enabled)("DockerSandbox (real Docker)", () => {
  let workspace: string;
  const config = loadSandboxConfig({ SANDBOX_ENABLED: "true", SANDBOX_INSTALL_ENABLED: "true", SANDBOX_TIMEOUT_SECONDS: "20" });
  const leftovers = (label: string) =>
    execFileSync("docker", ["ps", "-a", "-q", "--filter", `label=pd.run=${label}`], { encoding: "utf8" }).trim() +
    execFileSync("docker", ["volume", "ls", "-q", "--filter", `label=pd.run=${label}`], { encoding: "utf8" }).trim();

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "pd-sbx-it-"));
    await writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "probe", scripts: { test: "node probe.js" } }));
    await writeFile(path.join(workspace, "probe.js"), PROBE);
    await mkdir(path.join(workspace, ".git"));
    await writeFile(path.join(workspace, ".git", "config"), "[core]\n");
  });
  afterAll(() => rm(workspace, { recursive: true, force: true }));

  const setup = (test: string[], install: string[] | null = null): TestSetup => ({
    id: "npm",
    runtime: "node",
    image: config.images.node,
    install: install && { id: "probe-install", argv: install, display: install.join(" "), env: { HOME: "/tmp" } },
    test: { id: "probe-test", argv: test, display: test.join(" "), env: { HOME: "/tmp", CI: "true" } },
    needsInstall: false,
    notes: [],
  });

  it("runs the tests isolated: no network, unprivileged, read-only, no host secrets, no .git", async () => {
    process.env.PD_HOST_CANARY = "must-not-leak";
    const sandbox = new DockerSandbox(config);
    expect(await sandbox.status()).toEqual({ available: true, installEnabled: true });
    const session = await sandbox.open("itprobe", workspace, setup(["node", "probe.js"]));
    try {
      const r = await session.test();
      expect(r).toMatchObject({ kind: "TEST", exitCode: 7, timedOut: false, network: false });
      const probe = JSON.parse(r.output.split("PROBE ")[1]!);
      expect(probe).toEqual({
        uid: 1000,
        interfaces: ["lo"],
        rootWritable: false,
        tmpWritable: true,
        workWritable: true,
        dockerSocket: false,
        gitDir: false,
        canary: null,
        hostKeys: [],
        hostname: "sandbox",
      });
    } finally {
      await session.close();
      delete process.env.PD_HOST_CANARY;
    }
    expect(leftovers("itprobe")).toBe("");
  }, 180_000);

  it("gives only the install step a network interface", async () => {
    const netProbe = ["node", "-e", "console.log('IFACES ' + Object.keys(require('os').networkInterfaces()).sort().join(','))"];
    const session = await new DockerSandbox(config).open("itnet", workspace, setup(netProbe, netProbe));
    try {
      const install = await session.install();
      const test = await session.test();
      expect(install).toMatchObject({ kind: "INSTALL", network: true, exitCode: 0 });
      expect(install.output).toMatch(/IFACES (?=.*eth0)(?=.*lo)/);
      expect(test.output).toContain("IFACES lo\n");
    } finally {
      await session.close();
    }
    expect(leftovers("itnet")).toBe("");
  }, 180_000);

  it("works with the pinned Python image", async () => {
    const py: TestSetup = { ...setup(["python", "-c", "import os; print('PY', os.getuid(), os.path.exists('/work/probe.js'))"]), id: "pytest", runtime: "python", image: config.images.python };
    const session = await new DockerSandbox(config).open("itpython", workspace, py);
    try {
      expect(await session.test()).toMatchObject({ exitCode: 0, output: "PY 1000 True\n" });
    } finally {
      await session.close();
    }
    expect(leftovers("itpython")).toBe("");
  }, 180_000);

  it("kills a run at its time limit and cleans up", async () => {
    const short = new DockerSandbox({ ...config, testTimeoutMs: 3000 });
    const session = await short.open("ittimeout", workspace, setup(["node", "-e", "setInterval(() => {}, 1000)"]));
    const started = Date.now();
    try {
      expect(await session.test()).toMatchObject({ timedOut: true, exitCode: null });
      expect(Date.now() - started).toBeLessThan(60_000);
    } finally {
      await session.close();
    }
    expect(leftovers("ittimeout")).toBe("");
  }, 180_000);
});
