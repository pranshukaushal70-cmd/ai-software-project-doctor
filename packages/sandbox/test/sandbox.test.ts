import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  containerArgs,
  createSandbox,
  DEFAULT_IMAGES,
  DisabledSandbox,
  DockerSandbox,
  FakeSandbox,
  loadSandboxConfig,
  resolveTestSetup,
  sanitizeOutput,
  type DockerExec,
  type SandboxConfig,
  type TestSetup,
} from "../src";

const config = (env: Record<string, string> = {}): SandboxConfig => loadSandboxConfig(env);

// ---------------------------------------------------------------- configuration

describe("loadSandboxConfig", () => {
  it("is off by default, including the network-enabled install step", () => {
    expect(config()).toEqual({
      enabled: false,
      installEnabled: false,
      runtime: "runc",
      images: DEFAULT_IMAGES,
      testTimeoutMs: 300_000,
      installTimeoutMs: 300_000,
      memoryMb: 1024,
      cpus: 1,
      pids: 256,
    });
    expect(createSandbox(config())).toBeInstanceOf(DisabledSandbox);
    expect(createSandbox(config({ SANDBOX_ENABLED: "true" }))).toBeInstanceOf(DockerSandbox);
  });

  it("only accepts images pinned by digest and bounded limits", () => {
    expect(() => config({ SANDBOX_IMAGE_NODE: "node:24-slim" })).toThrow(/pinned by digest/);
    expect(() => config({ SANDBOX_IMAGE_NODE: `node@sha256:${"a".repeat(63)}` })).toThrow();
    expect(config({ SANDBOX_IMAGE_NODE: `registry.example/node:24@sha256:${"a".repeat(64)}` }).images.node).toContain("registry.example/node:24@sha256:");
    expect(() => config({ SANDBOX_RUNTIME: "kata" })).toThrow();
    expect(() => config({ SANDBOX_MEMORY_MB: "999999" })).toThrow();
    expect(config({ SANDBOX_INSTALL_ENABLED: "1", SANDBOX_RUNTIME: "runsc" })).toMatchObject({ installEnabled: true, runtime: "runsc" });
  });
});

// ---------------------------------------------------------------- command resolution

describe("resolveTestSetup", () => {
  const resolve = (files: Record<string, string>) => resolveTestSetup({ files: Object.keys(files), readFile: async (p) => files[p] ?? null, config: config() });
  const pkg = (o: object) => JSON.stringify(o);

  it("runs npm test, installing from the lockfile without lifecycle scripts", async () => {
    const r = await resolve({ "package.json": pkg({ scripts: { test: "vitest run" }, devDependencies: { vitest: "1" } }), "package-lock.json": "{}" });
    expect(r.ok && r.setup).toMatchObject({
      id: "npm",
      runtime: "node",
      image: DEFAULT_IMAGES.node,
      needsInstall: true,
      install: { id: "npm-ci", display: "npm ci --ignore-scripts --no-audit --no-fund --loglevel=error" },
      test: { id: "npm-test", display: "npm test" },
    });
  });

  it("falls back to npm install without a lockfile, and installs nothing without dependencies", async () => {
    const r = await resolve({ "package.json": pkg({ scripts: { test: "node test.js" }, dependencies: { express: "4" } }), "yarn.lock": "" });
    expect(r.ok && r.setup.install?.argv).toEqual(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error"]);
    expect(r.ok && r.setup.notes.join(" ")).toMatch(/another package manager/);
    const bare = await resolve({ "package.json": pkg({ scripts: { test: "node test.js" } }) });
    expect(bare.ok && bare.setup).toMatchObject({ install: null, needsInstall: false });
  });

  it("runs pytest, installing wheels only into the workspace", async () => {
    const r = await resolve({ "requirements.txt": "flask\n", "tests/test_app.py": "", "app.py": "" });
    expect(r.ok && r.setup).toMatchObject({ id: "pytest", image: DEFAULT_IMAGES.python, needsInstall: true, test: { display: "python -m pytest -q -p no:cacheprovider" } });
    expect(r.ok && r.setup.install?.argv).toEqual(["python", "-m", "pip", "install", "--no-input", "--disable-pip-version-check", "--no-cache-dir", "--only-binary=:all:", "--target", "/work/.pd-deps", "-r", "requirements.txt", "pytest"]);
  });

  it("explains when there is nothing it can run", async () => {
    expect(await resolve({ "package.json": pkg({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })).toEqual({
      ok: false,
      reason: "No supported test setup: package.json's test script is npm's placeholder; no Python test files. Supported: an npm test script, or pytest.",
    });
    expect(await resolve({ "package.json": "{ not json", "main.go": "" })).toMatchObject({ ok: false });
    expect(await resolve({ "README.md": "" })).toMatchObject({ ok: false, reason: expect.stringContaining("no Python test files") });
  });

  it("never passes host environment variables, only the template's", async () => {
    process.env.PD_HOST_CANARY = "must-not-leak";
    const r = await resolve({ "package.json": pkg({ scripts: { test: "x" } }) });
    expect(JSON.stringify(r)).not.toContain("must-not-leak");
    expect(r.ok && Object.keys(r.setup.test.env).sort()).toEqual(["CI", "FORCE_COLOR", "HOME", "NO_COLOR", "npm_config_audit", "npm_config_cache", "npm_config_fund", "npm_config_update_notifier"]);
    delete process.env.PD_HOST_CANARY;
  });
});

// ---------------------------------------------------------------- output

describe("sanitizeOutput", () => {
  it("removes terminal escapes and control characters and normalises line endings", () => {
    const esc = String.fromCharCode(27);
    const raw = `${esc}[31mFAIL${esc}[0m tests/a.test.ts\r\nline two\rline three${String.fromCharCode(7)}\n`;
    expect(sanitizeOutput(raw)).toEqual({ output: "FAIL tests/a.test.ts\nline two\nline three\n", truncated: false });
  });

  it("redacts credentials the tests print", () => {
    const key = ["sk", "live", "51HaBcDeFgHiJkLmNoPqRsTuV"].join("_");
    expect(sanitizeOutput(`using key ${key}\n`).output).not.toContain(key);
  });

  it("keeps the end of long output, from a line boundary", () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`).join("\n");
    const { output, truncated } = sanitizeOutput(lines);
    expect(truncated).toBe(true);
    expect(output.startsWith("[earlier output truncated]\nline ")).toBe(true);
    expect(output.endsWith("line 19999")).toBe(true);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(64 * 1024 + 40);
  });
});

// ---------------------------------------------------------------- container flags

describe("containerArgs", () => {
  const base = { name: "c1", runLabel: "run1", volume: "v1", image: DEFAULT_IMAGES.node, argv: ["npm", "test"], env: { CI: "true" } };
  const limits = config();

  it("isolates test containers: no network, read-only, unprivileged, bounded, nothing from the host", () => {
    const args = containerArgs({ ...base, network: false, user: "sandbox" }, limits);
    const pairs = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
    expect(args[0]).toBe("create");
    expect(pairs("--network")).toEqual(["none"]);
    expect(args).toContain("--read-only");
    expect(pairs("--user")).toEqual(["1000:1000"]);
    expect(pairs("--cap-drop")).toEqual(["ALL"]);
    expect(pairs("--cap-add")).toEqual([]);
    expect(pairs("--security-opt")).toEqual(["no-new-privileges"]);
    expect(pairs("--pids-limit")).toEqual(["256"]);
    expect(pairs("--memory")).toEqual(["1024m"]);
    expect(pairs("--memory-swap")).toEqual(["1024m"]);
    expect(pairs("--cpus")).toEqual(["1"]);
    expect(pairs("--tmpfs")).toEqual(["/tmp:rw,nosuid,nodev,noexec,size=512m"]);
    // The only mount is the run's own volume; no host path, no socket.
    expect(pairs("--mount")).toEqual(["type=volume,source=v1,target=/work"]);
    expect(args.some((a) => a === "-v" || a === "--volume" || a === "--privileged" || a.includes("docker.sock"))).toBe(false);
    expect(pairs("--env")).toEqual(["CI=true"]);
    expect(args.slice(-3)).toEqual(["npm", DEFAULT_IMAGES.node, "test"]);
  });

  it("gives the install step network access, and the ownership hand-over CAP_CHOWN only", () => {
    expect(containerArgs({ ...base, network: true, user: "sandbox" }, limits)).toEqual(expect.arrayContaining(["--network", "bridge"]));
    const prep = containerArgs({ ...base, argv: ["chown", "-R", "1000:1000", "/work"], network: false, user: "root" }, limits);
    expect(prep.join(" ")).toContain("--user 0:0 --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges");
    expect(prep).toEqual(expect.arrayContaining(["--network", "none"]));
  });

  it("uses gVisor when configured", () => {
    expect(containerArgs({ ...base, network: false, user: "sandbox" }, config({ SANDBOX_RUNTIME: "runsc" }))).toEqual(expect.arrayContaining(["--runtime", "runsc"]));
  });
});

// ---------------------------------------------------------------- driver (fake docker CLI)

describe("DockerSandbox", () => {
  let workspace: string;
  beforeAll(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), "pd-sbx-"));
    await mkdir(path.join(workspace, "src"));
    await mkdir(path.join(workspace, ".git"));
    await writeFile(path.join(workspace, "package.json"), "{}");
  });
  afterAll(() => rm(workspace, { recursive: true, force: true }));

  const setup: TestSetup = {
    id: "npm",
    runtime: "node",
    image: DEFAULT_IMAGES.node,
    install: { id: "npm-ci", argv: ["npm", "ci", "--ignore-scripts"], display: "npm ci --ignore-scripts", env: {} },
    test: { id: "npm-test", argv: ["npm", "test"], display: "npm test", env: { CI: "true" } },
    needsInstall: true,
    notes: [],
  };

  /** Records every docker invocation; `respond` decides the outcome by subcommand. */
  function fakeDocker(respond: (args: string[]) => Partial<{ code: number; output: string; timedOut: boolean }> = () => ({})) {
    const calls: string[][] = [];
    const exec: DockerExec = async (args) => {
      calls.push(args);
      const r = respond(args);
      return { code: 0, output: args[0] === "inspect" ? "0" : "", dropped: false, timedOut: false, ...r };
    };
    return { calls, exec, verbs: () => calls.map((c) => (c[0] === "volume" ? `volume ${c[1]}` : c[0])) };
  }

  it("copies the workspace without .git, hands it to the sandbox user, runs the tests and removes everything", async () => {
    const d = fakeDocker((a) => (a[0] === "start" && a.at(-1)!.endsWith("-1") ? { output: "1 passed\n" } : {}));
    const sandbox = new DockerSandbox(config({ SANDBOX_ENABLED: "true" }), d.exec);
    const session = await sandbox.open("run_ABC!", workspace, setup);
    const result = await session.test();
    await session.close();
    expect(d.verbs()).toEqual(["volume create", "create", "cp", "cp", "start", "inspect", "rm", "create", "start", "inspect", "rm", "rm", "volume rm"]);
    const copied = d.calls.filter((c) => c[0] === "cp").map((c) => path.basename(c[1]!));
    expect(copied.sort()).toEqual(["package.json", "src"]);
    expect(d.calls[1]).toEqual(expect.arrayContaining(["--user", "0:0", "--cap-add", "CHOWN", "--entrypoint", "chown"]));
    const testCreate = d.calls[7]!;
    expect(testCreate).toEqual(expect.arrayContaining(["--network", "none", "--user", "1000:1000"]));
    expect(testCreate.join(" ")).toMatch(/--label pd\.run=runabc /);
    expect(result).toEqual({ kind: "TEST", commandId: "npm-test", command: "npm test", image: DEFAULT_IMAGES.node, network: false, exitCode: 0, timedOut: false, durationMs: expect.any(Number), output: "1 passed\n", outputTruncated: false });
  });

  it("reports the exit code and kills a test run at its time limit", async () => {
    const d = fakeDocker((a) => (a[0] === "start" && a.at(-1)!.endsWith("-1") ? { timedOut: true, code: null as unknown as number } : {}));
    const session = await new DockerSandbox(config({ SANDBOX_ENABLED: "true" }), d.exec).open("r1", workspace, setup);
    const result = await session.test();
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(d.verbs().slice(-3)).toEqual(["start", "kill", "rm"]);

    // Only the test container (…-1) fails; the ownership hand-over (…-0) succeeds.
    const failing = fakeDocker((a) => (a[0] === "inspect" && a.at(-1)!.endsWith("-1") ? { output: "1\n" } : {}));
    const s2 = await new DockerSandbox(config({ SANDBOX_ENABLED: "true" }), failing.exec).open("r2", workspace, setup);
    expect((await s2.test()).exitCode).toBe(1);
  });

  it("runs the install step with network only when enabled", async () => {
    const off = fakeDocker();
    const s = await new DockerSandbox(config({ SANDBOX_ENABLED: "true" }), off.exec).open("r1", workspace, setup);
    await expect(s.install()).rejects.toThrow(/SANDBOX_INSTALL_ENABLED=false/);
    const on = fakeDocker();
    const s2 = await new DockerSandbox(config({ SANDBOX_ENABLED: "true", SANDBOX_INSTALL_ENABLED: "true" }), on.exec).open("r1", workspace, setup);
    const result = await s2.install();
    expect(result).toMatchObject({ kind: "INSTALL", network: true, commandId: "npm-ci" });
    expect(on.calls.filter((c) => c[0] === "create").at(-1)).toEqual(expect.arrayContaining(["--network", "bridge", "--user", "1000:1000"]));
  });

  it("cleans up when preparing the sandbox fails", async () => {
    const d = fakeDocker((a) => (a[0] === "cp" ? { code: 1 } : {}));
    await expect(new DockerSandbox(config({ SANDBOX_ENABLED: "true" }), d.exec).open("r1", workspace, setup)).rejects.toThrow(/workspace copy failed/);
    expect(d.verbs().slice(-3)).toEqual(["rm", "rm", "volume rm"]);
  });

  it("reports whether Docker can be used", async () => {
    const ok = fakeDocker((a) => (a[0] === "version" ? { output: "linux\n" } : {}));
    expect(await new DockerSandbox(config({ SANDBOX_ENABLED: "true", SANDBOX_INSTALL_ENABLED: "true" }), ok.exec).status()).toEqual({ available: true, installEnabled: true });
    const windows = fakeDocker(() => ({ output: "windows" }));
    expect(await new DockerSandbox(config({ SANDBOX_ENABLED: "true" }), windows.exec).status()).toMatchObject({ available: false });
    const down = fakeDocker(() => ({ code: 1 }));
    expect(await new DockerSandbox(config({ SANDBOX_ENABLED: "true" }), down.exec).status()).toEqual({ available: false, reason: "Docker is not reachable from the worker." });
    expect(await new DisabledSandbox().status()).toMatchObject({ available: false, reason: expect.stringContaining("SANDBOX_ENABLED=false") });
  });
});

describe("FakeSandbox", () => {
  it("returns scripted results and records calls", async () => {
    const setup = (await resolveTestSetup({ files: ["package.json"], readFile: async () => '{"scripts":{"test":"x"}}', config: config() })) as { ok: true; setup: TestSetup };
    const fake = new FakeSandbox({ test: [{ exitCode: 1 }, { exitCode: 0 }] });
    const s = await fake.open("r", "/w", setup.setup);
    expect((await s.test()).exitCode).toBe(1);
    expect((await s.test()).exitCode).toBe(0);
    await s.close();
    expect(fake.calls).toEqual(["test", "test", "close"]);
  });
});
