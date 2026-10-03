import type { SandboxConfig } from "./config";

/**
 * Which commands the sandbox may run, decided deterministically from the
 * repository's files: never chosen or written by a model. Each setup is one of a
 * fixed set of templates; the only repository-controlled part is what the
 * repository's own test script does, and that runs inside the sandbox with no
 * network. Install commands never run lifecycle scripts (`--ignore-scripts`) and
 * Python installs accept wheels only (`--only-binary=:all:`), because building a
 * source distribution executes its setup code.
 */

export interface CommandSpec {
  /** Template id, stored with each execution. */
  id: string;
  argv: string[];
  /** The exact command line shown to the user before they approve it. */
  display: string;
  /** Environment set inside the container; nothing from the host is passed. */
  env: Record<string, string>;
}

export interface TestSetup {
  id: "npm" | "pytest";
  runtime: "node" | "python";
  image: string;
  /** Dependency install (network-enabled, separately approved); null when there is nothing to install. */
  install: CommandSpec | null;
  test: CommandSpec;
  /** True when the tests cannot run without the install step (e.g. pytest is not in the image). */
  needsInstall: boolean;
  /** Short explanations of how the setup was chosen, shown to the user. */
  notes: string[];
}

export type TestSetupResolution = { ok: true; setup: TestSetup } | { ok: false; reason: string };

export interface ResolveInput {
  /** Repository-relative paths of the workspace's files. */
  files: Iterable<string>;
  /** Reads a small repository file (package.json, requirements files); null when unreadable. */
  readFile(path: string): Promise<string | null>;
  config: Pick<SandboxConfig, "images">;
}

const MAX_MANIFEST_BYTES = 1024 * 1024;
/** What `npm init` writes when a project has no tests. */
const NPM_PLACEHOLDER_TEST = /no test specified/i;
const PY_TEST_FILE = /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$|(?:^|\/)conftest\.py$/;
const REQUIREMENTS = ["requirements.txt", "requirements-dev.txt", "requirements-test.txt", "requirements_dev.txt", "requirements_test.txt"];

const NODE_ENV = {
  CI: "true",
  HOME: "/tmp",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  npm_config_cache: "/tmp/.npm",
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
};
/** Dependencies installed for Python go here, inside the workspace volume (the image's own site-packages is read-only). */
const PY_DEPS = "/work/.pd-deps";
const PY_ENV = { CI: "true", HOME: "/tmp", NO_COLOR: "1", PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: `${PY_DEPS}:/work`, PIP_NO_INPUT: "1" };

const quote = (a: string) => (/^[\w./:=@+,-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);
const spec = (id: string, argv: string[], env: Record<string, string>): CommandSpec => ({ id, argv, display: argv.map(quote).join(" "), env });

export async function resolveTestSetup(input: ResolveInput): Promise<TestSetupResolution> {
  const files = new Set(input.files);
  const reasons: string[] = [];

  // ---------------------------------------------------------------- Node (npm)
  if (files.has("package.json")) {
    const pkg = parseJson(await input.readFile("package.json"));
    const test = pkg && typeof pkg === "object" ? (pkg as { scripts?: Record<string, unknown> }).scripts?.test : undefined;
    if (typeof test === "string" && test.trim() && !NPM_PLACEHOLDER_TEST.test(test)) {
      const deps = pkg as { dependencies?: object; devDependencies?: object };
      const hasDeps = Object.keys(deps.dependencies ?? {}).length + Object.keys(deps.devDependencies ?? {}).length > 0;
      const notes = [`package.json defines a test script.`];
      let install: CommandSpec | null = null;
      if (files.has("package-lock.json") || files.has("npm-shrinkwrap.json")) {
        install = spec("npm-ci", ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], NODE_ENV);
        notes.push("Dependencies install from the committed npm lockfile, without lifecycle scripts.");
      } else if (hasDeps) {
        install = spec("npm-install", ["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--loglevel=error"], NODE_ENV);
        notes.push(
          files.has("yarn.lock") || files.has("pnpm-lock.yaml") || files.has("bun.lock") || files.has("bun.lockb")
            ? "The repository uses another package manager's lockfile; npm installs the declared ranges instead, so versions may differ."
            : "No lockfile: npm installs the declared version ranges, without lifecycle scripts.",
        );
      }
      return {
        ok: true,
        setup: { id: "npm", runtime: "node", image: input.config.images.node, install, test: spec("npm-test", ["npm", "test"], NODE_ENV), needsInstall: hasDeps, notes },
      };
    }
    reasons.push(typeof test === "string" ? "package.json's test script is npm's placeholder" : "package.json has no test script");
  }

  // ---------------------------------------------------------------- Python (pytest)
  const pyTests = [...files].some((f) => PY_TEST_FILE.test(f));
  if (pyTests) {
    const requirements = REQUIREMENTS.filter((r) => files.has(r));
    const argv = ["python", "-m", "pip", "install", "--no-input", "--disable-pip-version-check", "--no-cache-dir", "--only-binary=:all:", "--target", PY_DEPS];
    for (const r of requirements) argv.push("-r", r);
    argv.push("pytest");
    const notes = [
      "Python test files found; tests run with pytest.",
      requirements.length ? `Dependencies install from ${requirements.join(", ")} as prebuilt wheels only.` : "No requirements file: only pytest is installed.",
    ];
    return {
      ok: true,
      setup: {
        id: "pytest",
        runtime: "python",
        image: input.config.images.python,
        install: spec("pip-install", argv, PY_ENV),
        test: spec("pytest", ["python", "-m", "pytest", "-q", "-p", "no:cacheprovider"], PY_ENV),
        // pytest is not part of the image.
        needsInstall: true,
        notes,
      },
    };
  }
  reasons.push("no Python test files");
  return { ok: false, reason: `No supported test setup: ${reasons.join("; ")}. Supported: an npm test script, or pytest.` };
}

function parseJson(text: string | null): unknown {
  if (text === null || Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) return null;
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
}
