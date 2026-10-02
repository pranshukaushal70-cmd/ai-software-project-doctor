import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyzeDependencies,
  compareVersions,
  cvss3BaseScore,
  cvssSeverity,
  DEPENDENCY_RULES,
  exactNpmVersion,
  fixedVersionFor,
  isPublicNpmRegistry,
  lookupVulnerabilities,
  npmSource,
  parseAdvisory,
  parseBunLock,
  parseCargoLock,
  parseCargoToml,
  parseGoMod,
  parseGradle,
  parseNpmRegistryConfig,
  parsePackageJson,
  parsePackageLock,
  parsePipfileLock,
  parsePnpmLock,
  parsePom,
  parsePyprojectOrPipfile,
  parsePythonLock,
  parseRequirementsTxt,
  parseYarnLock,
  redactSpec,
  type AnalyzeDependenciesOptions,
} from "../src/dependencies";
import { scanRepository } from "../src/scanner";

// ------------------------------------------------------------------ helpers

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

/** Write files to a temporary repository and analyse its dependencies. */
async function analyzeRepo(files: Record<string, string>, opts?: AnalyzeDependenciesOptions) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pd-deps-test-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  const scan = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
  return analyzeDependencies(scan.files, opts);
}

const json = (v: unknown) => JSON.stringify(v, null, 2);

interface FakeOsv {
  /** Advisory ids per `name@version`. */
  vulns?: Record<string, string[]>;
  /** Advisory documents by id; a missing id answers HTTP 404. */
  advisories?: Record<string, unknown>;
  /** Fail every request of this kind. */
  fail?: "querybatch" | "vulns" | "network";
}

/** In-memory OSV.dev: answers querybatch and vulns/{id} and records every request. */
function fakeOsv(cfg: FakeOsv) {
  const requests: Array<{ url: string; body: unknown }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    requests.push({ url, body });
    if (cfg.fail === "network") throw new TypeError("fetch failed");
    if (url.endsWith("/querybatch")) {
      if (cfg.fail === "querybatch") return new Response("oops", { status: 500 });
      const queries = (body as { queries: Array<{ package: { name: string }; version: string }> }).queries;
      return Response.json({
        results: queries.map((q) => {
          const ids = cfg.vulns?.[`${q.package.name}@${q.version}`] ?? [];
          return ids.length ? { vulns: ids.map((id) => ({ id, modified: "2024-01-01T00:00:00Z" })) } : {};
        }),
      });
    }
    const id = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
    if (cfg.fail === "vulns") return new Response("unavailable", { status: 503 });
    const adv = cfg.advisories?.[id];
    return adv ? Response.json(adv) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

const CVSS_9_8 = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H";
const CVSS_7_2 = "CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H";

const advisory = (id: string, ecosystem: string, name: string, fixed: string | null, extra: Record<string, unknown> = {}) => ({
  id,
  summary: `Problem in ${name}`,
  affected: [
    {
      package: { ecosystem, name },
      ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, ...(fixed ? [{ fixed }] : [])] }],
    },
  ],
  ...extra,
});

// ------------------------------------------------------------------ npm parsers

describe("npm parsers", () => {
  it("classifies version specs by source", () => {
    expect(npmSource("^1.2.3")).toBe("registry");
    expect(npmSource("npm:other@1")).toBe("registry");
    expect(npmSource("workspace:*")).toBe("workspace");
    expect(npmSource("file:../lib")).toBe("path");
    expect(npmSource("github:me/fork#abc")).toBe("git");
    expect(npmSource("me/fork")).toBe("git");
    expect(npmSource("git+https://example.com/x.git")).toBe("git");
    expect(npmSource("https://example.com/x.tgz")).toBe("url");
  });

  it("recognises exact versions only", () => {
    expect(exactNpmVersion("1.2.3")).toBe("1.2.3");
    expect(exactNpmVersion("=1.2.3-beta.1")).toBe("1.2.3-beta.1");
    expect(exactNpmVersion("v2.0.0")).toBe("2.0.0");
    expect(exactNpmVersion("^1.2.3")).toBeNull();
    expect(exactNpmVersion("1.x")).toBeNull();
    expect(exactNpmVersion("*")).toBeNull();
  });

  it("reads direct dependencies with dev flag and declaration line", () => {
    const text = json({
      name: "app",
      dependencies: { lodash: "^4.17.0", "left-pad": "1.3.0" },
      devDependencies: { vitest: "^5.0.0", lodash: "^4.0.0" },
    });
    const m = parsePackageJson("package.json", text)!;
    expect(m.dependencies.map((d) => [d.name, d.dev, d.resolvedVersion])).toEqual([
      ["lodash", false, null],
      ["left-pad", false, "1.3.0"],
      ["vitest", true, null],
    ]);
    const lines = text.split("\n");
    for (const d of m.dependencies) expect(lines[d.line! - 1]).toContain(`"${d.name}"`);
    expect(parsePackageJson("package.json", "{ not json")).toBeNull();
  });

  it("reads package-lock v3 with locations, dev flags and registries", () => {
    const lock = parsePackageLock(
      json({
        lockfileVersion: 3,
        packages: {
          "": { name: "app" },
          "node_modules/a": { version: "1.0.0", resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz" },
          "node_modules/b": { version: "2.0.0", dev: true },
          "node_modules/a/node_modules/b": { version: "1.5.0" },
          "node_modules/private": { version: "3.0.0", resolved: "https://npm.corp.example/private/-/private-3.0.0.tgz" },
          "node_modules/linked": { link: true, resolved: "packages/linked" },
          "node_modules/fromgit": { version: "0.0.1", resolved: "git+ssh://git@github.com/x/y.git#abc" },
        },
      }),
    );
    expect(lock.map((l) => [l.location, l.version, l.dev, l.publicRegistry])).toEqual([
      ["node_modules/a", "1.0.0", false, true],
      ["node_modules/b", "2.0.0", true, true],
      ["node_modules/a/node_modules/b", "1.5.0", false, true],
      ["node_modules/private", "3.0.0", false, false],
    ]);
    expect(lock.every((l) => l.line !== null)).toBe(true);
  });

  it("reads package-lock v1 nested dependencies", () => {
    const lock = parsePackageLock(
      json({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0", dependencies: { b: { version: "2.0.0", dev: true } } } } }),
    );
    expect(lock.map((l) => [l.name, l.version, l.location, l.dev]).sort()).toEqual([
      ["a", "1.0.0", "node_modules/a", false],
      ["b", "2.0.0", "node_modules/a/node_modules/b", true],
    ]);
  });

  it("reads classic and Berry yarn.lock", () => {
    const classic = parseYarnLock(
      [
        "# yarn lockfile v1",
        "",
        "lodash@^4.17.0, lodash@^4.17.20:",
        '  version "4.17.21"',
        '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz"',
        "",
        '"@babel/core@^7.0.0":',
        '  version "7.23.0"',
      ].join("\n"),
    );
    expect(classic.map((l) => [l.name, l.version])).toEqual([
      ["lodash", "4.17.21"],
      ["@babel/core", "7.23.0"],
    ]);
    expect(classic[0]!.specs).toContain("lodash@^4.17.0");

    const berry = parseYarnLock(
      [
        "__metadata:",
        "  version: 6",
        "",
        '"lodash@npm:^4.17.0":',
        "  version: 4.17.21",
        '  resolution: "lodash@npm:4.17.21"',
        "",
        '"my-ws@workspace:packages/ws":',
        "  version: 0.0.0-use.local",
      ].join("\n"),
    );
    expect(berry.map((l) => [l.name, l.version, l.specs])).toEqual([["lodash", "4.17.21", ["lodash@^4.17.0"]]]);
  });

  it("reads pnpm-lock v9 importers and packages", () => {
    const { packages, importers } = parsePnpmLock(
      [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      lodash:",
        "        specifier: ^4.17.0",
        "        version: 4.17.21",
        "",
        "  packages/web:",
        "    dependencies:",
        "      react:",
        "        specifier: ^18.0.0",
        "        version: 18.2.0(react-dom@18.2.0)",
        "",
        "packages:",
        "",
        "  lodash@4.17.21:",
        "    resolution: {integrity: sha512-x}",
        "",
        "  '@types/node@20.0.0':",
        "    resolution: {integrity: sha512-y}",
      ].join("\n"),
    );
    expect(importers.get(".")?.get("lodash")).toBe("4.17.21");
    expect(importers.get("packages/web")?.get("react")).toBe("18.2.0");
    expect(packages.map((p) => `${p.name}@${p.version}`)).toEqual(["lodash@4.17.21", "@types/node@20.0.0"]);
  });
});

// ------------------------------------------------------------------ Python parsers

describe("Python parsers", () => {
  it("reads requirements files: pins, ranges, editables, hashes and dev files", () => {
    const m = parseRequirementsTxt(
      "requirements.txt",
      [
        "# runtime",
        "requests==2.19.0",
        "Flask>=2.0  # web",
        "-e git+https://github.com/org/tool.git#egg=Tool_Lib",
        "--index-url https://pypi.org/simple",
        "-r base.txt",
        "numpy==1.26.4 \\",
        "    --hash=sha256:abc",
        'uvicorn[standard]==0.30.0; python_version >= "3.9"',
      ].join("\n"),
    );
    expect(m.dependencies.map((d) => [d.name, d.versionSpec, d.resolvedVersion, d.source, d.line])).toEqual([
      ["requests", "==2.19.0", "2.19.0", "registry", 2],
      ["flask", ">=2.0", null, "registry", 3],
      ["tool-lib", "git+https://github.com/org/tool.git#egg=Tool_Lib", null, "git", 4],
      ["numpy", "==1.26.4", "1.26.4", "registry", 7],
      ["uvicorn", "==0.30.0", "0.30.0", "registry", 9],
    ]);
    expect(m.dependencies.every((d) => !d.dev)).toBe(true);
    expect(parseRequirementsTxt("requirements-dev.txt", "pytest==8.0.0").dependencies[0]!.dev).toBe(true);
  });

  it("reads PEP 621 and Poetry pyproject.toml", () => {
    const pep621 = parsePyprojectOrPipfile(
      "pyproject.toml",
      ['[project]', 'name = "svc"', "dependencies = [", '  "httpx>=0.27",', '  "pydantic==2.7.0",', "]", "", "[project.optional-dependencies]", 'test = ["pytest>=8"]', 'server = ["gunicorn"]'].join("\n"),
    );
    expect(pep621.dependencies.map((d) => [d.name, d.resolvedVersion, d.dev])).toEqual([
      ["httpx", null, false],
      ["pydantic", "2.7.0", false],
      ["pytest", null, true],
      ["gunicorn", null, false],
    ]);

    const poetry = parsePyprojectOrPipfile(
      "pyproject.toml",
      [
        "[tool.poetry.dependencies]",
        'python = "^3.11"',
        'Django = "^4.2"',
        'requests = { version = "2.31.0", extras = ["socks"] }',
        'mylib = { path = "../mylib" }',
        'forked = { git = "https://github.com/x/forked.git" }',
        "",
        "[tool.poetry.group.dev.dependencies]",
        'pytest = "^8.0"',
      ].join("\n"),
    );
    expect(poetry.dependencies.map((d) => [d.name, d.versionSpec, d.resolvedVersion, d.source, d.dev])).toEqual([
      ["django", "^4.2", null, "registry", false],
      ["requests", "==2.31.0", "2.31.0", "registry", false],
      ["mylib", "*", null, "path", false],
      ["forked", "*", null, "git", false],
      ["pytest", "^8.0", null, "registry", true],
    ]);
  });

  it("reads poetry.lock / uv.lock packages and skips non-registry ones", () => {
    const lock = parsePythonLock(
      [
        "[[package]]",
        'name = "Django"',
        'version = "4.2.1"',
        'category = "main"',
        "",
        "[[package]]",
        'name = "pytest"',
        'version = "8.1.0"',
        'category = "dev"',
        "",
        "[[package]]",
        'name = "mylib"',
        'version = "0.1.0"',
        "",
        "[package.source]",
        'type = "directory"',
        'url = "../mylib"',
        "",
        "[[package]]",
        'name = "app"',
        'version = "0.1.0"',
        'source = { editable = "." }',
      ].join("\n"),
    );
    expect(lock.map((l) => [l.name, l.version, l.dev])).toEqual([
      ["django", "4.2.1", false],
      ["pytest", "8.1.0", true],
    ]);
  });

  it("reads Pipfile.lock default and develop sections", () => {
    const lock = parsePipfileLock(json({ _meta: {}, default: { Requests: { version: "==2.31.0" }, vcs: { git: "https://x" } }, develop: { pytest: { version: "==8.0.0" } } }));
    expect(lock.map((l) => [l.name, l.version, l.dev])).toEqual([
      ["requests", "2.31.0", false],
      ["pytest", "8.0.0", true],
    ]);
  });
});

// ------------------------------------------------------------------ JVM / Go / Cargo parsers

describe("JVM, Go and Cargo parsers", () => {
  it("reads pom.xml with properties, managed versions and test scope; ignores plugins and comments", () => {
    const text = [
      "<project>",
      "  <parent><groupId>org.springframework.boot</groupId><artifactId>parent</artifactId><version>3.2.0</version></parent>",
      "  <version>1.0.0</version>",
      "  <properties><jackson.version>2.15.0</jackson.version></properties>",
      "  <dependencyManagement><dependencies>",
      "    <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>32.1.0-jre</version></dependency>",
      "  </dependencies></dependencyManagement>",
      "  <dependencies>",
      "    <dependency>",
      "      <groupId>com.fasterxml.jackson.core</groupId><artifactId>jackson-databind</artifactId><version>${jackson.version}</version>",
      "    </dependency>",
      "    <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId></dependency>",
      "    <!-- <dependency><groupId>x</groupId><artifactId>commented</artifactId><version>1</version></dependency> -->",
      "    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>[4.0,5.0)</version><scope>test</scope></dependency>",
      "  </dependencies>",
      "  <build><plugins><plugin><dependencies>",
      "    <dependency><groupId>p</groupId><artifactId>plugin-dep</artifactId><version>1.0</version></dependency>",
      "  </dependencies></plugin></plugins></build>",
      "</project>",
    ].join("\n");
    const m = parsePom("pom.xml", text);
    expect(m.dependencies.map((d) => [d.name, d.versionSpec, d.resolvedVersion, d.dev, d.line])).toEqual([
      ["com.fasterxml.jackson.core:jackson-databind", "${jackson.version}", "2.15.0", false, 9],
      ["com.google.guava:guava", "32.1.0-jre", "32.1.0-jre", false, 12],
      ["junit:junit", "[4.0,5.0)", null, true, 14],
    ]);
  });

  it("reads Gradle string notation with variables, test configurations and dynamic versions", () => {
    const m = parseGradle(
      "build.gradle",
      [
        'def jacksonVersion = "2.15.0"',
        "dependencies {",
        '    implementation "com.fasterxml.jackson.core:jackson-databind:${jacksonVersion}"',
        '    implementation("org.slf4j:slf4j-api:2.0.9")',
        "    testImplementation 'junit:junit:4.13.2'",
        '    // implementation "commented:out:1.0"',
        '    implementation "com.example:dynamic:1.+"',
        "}",
      ].join("\n"),
    );
    expect(m.dependencies.map((d) => [d.name, d.resolvedVersion, d.dev, d.line])).toEqual([
      ["com.fasterxml.jackson.core:jackson-databind", "2.15.0", false, 3],
      ["org.slf4j:slf4j-api", "2.0.9", false, 4],
      ["junit:junit", "4.13.2", true, 5],
      ["com.example:dynamic", null, false, 7],
    ]);
  });

  it("reads go.mod requires, indirect markers and local replaces", () => {
    const m = parseGoMod(
      "go.mod",
      [
        "module example.com/app",
        "",
        "go 1.22",
        "",
        "require (",
        "\tgithub.com/gin-gonic/gin v1.9.0",
        "\tgolang.org/x/net v0.10.0 // indirect",
        "\texample.com/local v0.0.0",
        ")",
        "",
        "require github.com/pkg/errors v0.9.1",
        "",
        "replace example.com/local => ../local",
      ].join("\n"),
    );
    expect(m.dependencies.map((d) => [d.name, d.resolvedVersion, d.direct, d.source, d.line])).toEqual([
      ["github.com/gin-gonic/gin", "v1.9.0", true, "registry", 6],
      ["golang.org/x/net", "v0.10.0", false, "registry", 7],
      ["example.com/local", null, true, "path", 8],
      ["github.com/pkg/errors", "v0.9.1", true, "registry", 11],
    ]);
  });

  it("reads Cargo.toml tables, renames and sources, and Cargo.lock registry packages", () => {
    const m = parseCargoToml(
      "Cargo.toml",
      [
        "[package]",
        'name = "app"',
        "",
        "[dependencies]",
        'serde = { version = "1.0", features = ["derive"] }',
        'rand = "=0.8.5"',
        'local = { path = "../local" }',
        'renamed = { package = "tokio", version = "1" }',
        "",
        "[dependencies.regex]",
        'version = "1.9"',
        "",
        "[dev-dependencies]",
        'proptest = "1.0"',
      ].join("\n"),
    );
    expect(m.dependencies.map((d) => [d.name, d.versionSpec, d.resolvedVersion, d.source, d.dev])).toEqual([
      ["serde", "1.0", null, "registry", false],
      ["rand", "=0.8.5", "0.8.5", "registry", false],
      ["local", null, null, "path", false],
      ["tokio", "1", null, "registry", false],
      ["regex", "1.9", null, "registry", false],
      ["proptest", "1.0", null, "registry", true],
    ]);

    const lock = parseCargoLock(
      [
        "version = 3",
        "",
        "[[package]]",
        'name = "app"',
        'version = "0.1.0"',
        "",
        "[[package]]",
        'name = "serde"',
        'version = "1.0.190"',
        'source = "registry+https://github.com/rust-lang/crates.io-index"',
        "",
        "[[package]]",
        'name = "internal"',
        'version = "0.2.0"',
        'source = "registry+https://cargo.corp.example/index"',
      ].join("\n"),
    );
    expect(lock.map((l) => [l.name, l.version, l.publicRegistry])).toEqual([
      ["serde", "1.0.190", true],
      ["internal", "0.2.0", false],
    ]);
  });
});

// ------------------------------------------------------------------ CVSS / OSV

describe("CVSS v3 scoring", () => {
  it.each([
    [CVSS_9_8, 9.8, "CRITICAL"],
    [CVSS_7_2, 7.2, "HIGH"],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1, "MEDIUM"],
    ["CVSS:3.0/AV:L/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N", 2.5, "LOW"],
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N", 0, "INFO"],
  ])("scores %s as %s", (vector, score, severity) => {
    expect(cvss3BaseScore(vector)).toBe(score);
    expect(cvssSeverity(score)).toBe(severity);
  });

  it("rejects other versions and malformed vectors", () => {
    expect(cvss3BaseScore("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N")).toBeNull();
    expect(cvss3BaseScore("CVSS:3.1/AV:N/AC:L")).toBeNull();
    expect(cvss3BaseScore("CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBeNull();
  });
});

describe("OSV advisories", () => {
  it("takes severity from CVSS, then from the advisory database", () => {
    const fromCvss = parseAdvisory({ ...advisory("GHSA-1111-2222-3333", "npm", "a", "1.0.1"), severity: [{ type: "CVSS_V3", score: CVSS_9_8 }] })!;
    expect([fromCvss.severity, fromCvss.score, fromCvss.severitySource]).toEqual(["CRITICAL", 9.8, "cvss-v3"]);
    const fromDb = parseAdvisory({ ...advisory("GHSA-4444-5555-6666", "npm", "a", null), database_specific: { severity: "MODERATE" } })!;
    expect([fromDb.severity, fromDb.score, fromDb.severitySource]).toEqual(["MEDIUM", null, "advisory"]);
    const unknown = parseAdvisory(advisory("OSV-2024-1", "npm", "a", null))!;
    expect([unknown.severity, unknown.severitySource]).toEqual(["MEDIUM", "unknown"]);
  });

  it("treats advisory content as untrusted", () => {
    expect(parseAdvisory({ id: "../../etc/passwd" })).toBeNull();
    expect(parseAdvisory({ id: "GHSA-x", withdrawn: "2024-01-01" })).toBeNull();
    expect(parseAdvisory("nope")).toBeNull();
    const a = parseAdvisory({ id: "GHSA-x", summary: "Bad `eval`\n\nin   code", aliases: ["CVE-2024-1", "<script>"] })!;
    expect(a.summary).toBe("Bad 'eval' in code");
    expect(a.aliases).toEqual(["CVE-2024-1"]);
    expect(parseAdvisory({ id: "GHSA-y", summary: "x".repeat(1000) })!.summary.length).toBeLessThanOrEqual(240);
  });

  it("compares versions numerically with pre-releases first", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareVersions("v1.2", "1.2.0")).toBe(0);
    expect(compareVersions("2.0.0", "10.0.0")).toBe(-1);
  });

  it("picks the lowest version that fixes every advisory", () => {
    const a = parseAdvisory(advisory("GHSA-a", "npm", "lodash", "4.17.19"))!;
    const b = parseAdvisory(advisory("GHSA-b", "npm", "lodash", "4.17.21"))!;
    const none = parseAdvisory(advisory("GHSA-c", "npm", "lodash", null))!;
    expect(fixedVersionFor([a, b], "npm", "lodash", "4.17.15")).toBe("4.17.21");
    expect(fixedVersionFor([a], "npm", "lodash", "4.17.20")).toBeNull();
    expect(fixedVersionFor([a, none], "npm", "lodash", "4.17.15")).toBeNull();
    const go = parseAdvisory(advisory("GO-2023-1", "Go", "golang.org/x/net", "0.17.0"))!;
    expect(fixedVersionFor([go], "Go", "golang.org/x/net", "v0.10.0")).toBe("v0.17.0");
    const py = parseAdvisory(advisory("PYSEC-1", "PyPI", "Flask_Login", "0.6.3"))!;
    expect(fixedVersionFor([py], "PyPI", "flask-login", "0.6.0")).toBe("0.6.3");
  });
});

describe("OSV lookup", () => {
  const queries = [
    { ecosystem: "npm" as const, name: "a", version: "1.0.0" },
    { ecosystem: "npm" as const, name: "b", version: "2.0.0" },
    { ecosystem: "npm" as const, name: "a", version: "1.0.0" },
    { ecosystem: "Go" as const, name: "golang.org/x/net", version: "v0.10.0" },
  ];

  it("batches unique queries, strips the Go `v` prefix and fetches advisory details", async () => {
    const osv = fakeOsv({ vulns: { "a@1.0.0": ["GHSA-a"] }, advisories: { "GHSA-a": advisory("GHSA-a", "npm", "a", "1.0.1") } });
    const res = await lookupVulnerabilities(queries, { fetch: osv.fetch });
    expect(res.status).toBe("completed");
    expect(res.queried).toBe(3);
    const batch = osv.requests[0]!.body as { queries: Array<{ package: { name: string }; version: string }> };
    expect(batch.queries.map((q) => `${q.package.name}@${q.version}`)).toEqual(["a@1.0.0", "b@2.0.0", "golang.org/x/net@0.10.0"]);
    expect(res.advisories.get("GHSA-a")?.detailed).toBe(true);
    expect(osv.requests.map((r) => r.url)).toEqual(["https://api.osv.dev/v1/querybatch", "https://api.osv.dev/v1/vulns/GHSA-a"]);
  });

  it("never throws: unreachable service, HTTP errors and malformed responses", async () => {
    for (const fail of ["network", "querybatch"] as const) {
      const res = await lookupVulnerabilities(queries, { fetch: fakeOsv({ fail }).fetch });
      expect(res.status).toBe("failed");
      expect(res.error).toMatch(/OSV\.dev/);
      expect(res.vulnsByPackage.size).toBe(0);
    }
    const short = (async () => Response.json({ results: [] })) as unknown as typeof fetch;
    const res = await lookupVulnerabilities(queries, { fetch: short });
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/unexpected response/);
  });

  it("reports partial results when advisory details cannot be fetched", async () => {
    const res = await lookupVulnerabilities(queries, { fetch: fakeOsv({ vulns: { "a@1.0.0": ["GHSA-a"] }, fail: "vulns" }).fetch });
    expect(res.status).toBe("partial");
    expect(res.vulnsByPackage.size).toBe(1);
    expect(res.advisories.get("GHSA-a")).toMatchObject({ detailed: false, severity: "MEDIUM" });
  });

  it("stops requesting details after maxDetails", async () => {
    const osv = fakeOsv({
      vulns: { "a@1.0.0": ["GHSA-1", "GHSA-2", "GHSA-3"] },
      advisories: { "GHSA-1": { id: "GHSA-1" }, "GHSA-2": { id: "GHSA-2" }, "GHSA-3": { id: "GHSA-3" } },
    });
    const res = await lookupVulnerabilities(queries, { fetch: osv.fetch, maxDetails: 1, concurrency: 1 });
    expect(res.status).toBe("partial");
    expect(osv.requests.filter((r) => r.url.includes("/vulns/"))).toHaveLength(1);
    expect([...res.advisories.values()].filter((a) => a.detailed)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ analyzeDependencies

describe("analyzeDependencies", () => {
  const npmRepo = {
    "package.json": json({
      name: "shop",
      dependencies: {
        lodash: "^4.17.0",
        express: "^4.18.0",
        "internal-lib": "^2.0.0",
        "my-fork": "github:me/fork#abc",
      },
      devDependencies: { minimist: "^1.2.0" },
    }),
    "package-lock.json": json({
      name: "shop",
      lockfileVersion: 3,
      packages: {
        "": { name: "shop" },
        "node_modules/lodash": { version: "4.17.20", resolved: "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz" },
        "node_modules/express": { version: "4.18.2", resolved: "https://registry.npmjs.org/express/-/express-4.18.2.tgz" },
        "node_modules/internal-lib": { version: "2.1.0", resolved: "https://npm.corp.example/internal-lib/-/internal-lib-2.1.0.tgz" },
        "node_modules/minimist": { version: "1.2.5", resolved: "https://registry.npmjs.org/minimist/-/minimist-1.2.5.tgz", dev: true },
        "node_modules/qs": { version: "6.11.0", resolved: "https://registry.npmjs.org/qs/-/qs-6.11.0.tgz" },
      },
    }),
  };
  const npmOsv = () =>
    fakeOsv({
      vulns: { "lodash@4.17.20": ["GHSA-lodash"], "minimist@1.2.5": ["GHSA-minimist"] },
      advisories: {
        "GHSA-lodash": advisory("GHSA-lodash", "npm", "lodash", "4.17.21", { aliases: ["CVE-2021-23337"], severity: [{ type: "CVSS_V3", score: CVSS_7_2 }] }),
        "GHSA-minimist": advisory("GHSA-minimist", "npm", "minimist", "1.2.6", { severity: [{ type: "CVSS_V3", score: CVSS_9_8 }] }),
      },
    });

  it("resolves npm versions from the lockfile and keeps transitive packages", async () => {
    const res = await analyzeRepo(npmRepo);
    const byName = new Map(res.dependencies.map((d) => [d.name, d]));
    expect(byName.get("lodash")).toMatchObject({ resolvedVersion: "4.17.20", direct: true, dev: false, manifestPath: "package.json" });
    expect(byName.get("minimist")).toMatchObject({ resolvedVersion: "1.2.5", direct: true, dev: true });
    expect(byName.get("internal-lib")).toMatchObject({ resolvedVersion: "2.1.0", publicRegistry: false });
    expect(byName.get("my-fork")).toMatchObject({ source: "git", resolvedVersion: null });
    expect(byName.get("qs")).toMatchObject({ direct: false, resolvedVersion: "6.11.0", manifestPath: "package-lock.json" });
    expect(res.dependencies).toHaveLength(6);
    expect(res.summary.totals).toMatchObject({ dependencies: 6, direct: 5, transitive: 1, dev: 1, resolved: 5 });
    expect(res.summary.manifests.map((m) => [m.path, m.kind])).toEqual([
      ["package-lock.json", "lockfile"],
      ["package.json", "manifest"],
    ]);
  });

  it("reports vulnerability data as disabled without a fetch function", async () => {
    const res = await analyzeRepo(npmRepo);
    expect(res.summary.vulnerabilityScan).toMatchObject({ status: "disabled", queried: 0, notChecked: 6 });
    expect(res.dependencies.every((d) => d.dataSource === null && d.vulnIds.length === 0)).toBe(true);
    expect(res.findings.map((f) => f.type)).toEqual([DEPENDENCY_RULES.nonRegistry.type]);
  });

  it("finds vulnerable packages with evidence, fixed versions and dev downgrade", async () => {
    const osv = npmOsv();
    const res = await analyzeRepo(npmRepo, { osv: { fetch: osv.fetch } });
    expect(res.summary.vulnerabilityScan).toMatchObject({ status: "completed", source: "osv.dev", queried: 4, notChecked: 2, error: null });

    const vulns = res.findings.filter((f) => f.type === DEPENDENCY_RULES.vulnerable.type);
    expect(vulns.map((f) => [f.data?.package, f.severity])).toEqual([
      ["lodash", "HIGH"],
      ["minimist", "HIGH"],
    ]);
    const lodash = vulns.find((f) => f.data?.package === "lodash")!;
    expect(lodash).toMatchObject({ category: "DEPENDENCY", ruleId: "dependency/known-vulnerability", path: "package.json", analyzer: "dependencies" });
    expect(lodash.line).toBeGreaterThan(1);
    expect(lodash.evidence).toContain("`lodash@4.17.20`");
    expect(lodash.evidence).toContain("GHSA-lodash / CVE-2021-23337 (HIGH, CVSS 7.2)");
    expect(lodash.recommendation).toBe("Upgrade lodash to 4.17.21 or later.");
    expect(lodash.data).toMatchObject({ fixedVersion: "4.17.21", direct: true, dev: false });

    const minimist = vulns.find((f) => f.data?.package === "minimist")!;
    expect(minimist.evidence).toContain("lowered one level");
    expect(minimist.data).toMatchObject({ dev: true, fixedVersion: "1.2.6" });

    expect(res.summary.totals).toMatchObject({ vulnerable: 2, vulnerableDirect: 2, advisories: 2 });
    expect(res.summary.totals.bySeverity.HIGH).toBe(2);
    expect(res.summary.vulnerable[0]).toMatchObject({ name: "lodash", fixedVersion: "4.17.21", severity: "HIGH" });
    const lodashDep = res.dependencies.find((d) => d.name === "lodash")!;
    expect(lodashDep).toMatchObject({ vulnIds: ["GHSA-lodash"], dataSource: "osv.dev" });
  });

  it("never sends private-registry or non-registry package names to OSV.dev", async () => {
    const osv = npmOsv();
    await analyzeRepo(npmRepo, { osv: { fetch: osv.fetch } });
    const sent = JSON.stringify(osv.requests);
    expect(sent).not.toContain("internal-lib");
    expect(sent).not.toContain("my-fork");
    expect(sent).toContain("qs");
  });

  it("degrades gracefully when OSV.dev is unreachable", async () => {
    const res = await analyzeRepo(npmRepo, { osv: { fetch: fakeOsv({ fail: "network" }).fetch } });
    expect(res.summary.vulnerabilityScan).toMatchObject({ status: "failed", error: "OSV.dev could not be reached" });
    expect(res.findings.some((f) => f.type === DEPENDENCY_RULES.vulnerable.type)).toBe(false);
    expect(res.dependencies.every((d) => d.dataSource === null)).toBe(true);
  });

  it("flags missing lockfiles, unpinned constraints and git sources; redacts URL credentials", async () => {
    const res = await analyzeRepo({
      "package.json": json({
        name: "loose",
        dependencies: { a: "^1.0.0", b: "*", c: "latest", priv: "git+https://deploy:hunter2@git.example.com/org/priv.git" },
        devDependencies: { d: "" },
      }),
    });
    const subject = (f: (typeof res.findings)[number]) => (f.type === "missing-lockfile" ? "" : f.evidence.match(/^`([^`]+)`/)?.[1]);
    expect(res.findings.map((f) => `${f.type}:${subject(f)}`).sort()).toEqual([
      "missing-lockfile:",
      "non-registry-dependency:priv",
      "unpinned-dependency:b",
      "unpinned-dependency:c",
      "unpinned-dependency:d",
    ]);
    expect(res.findings.find((f) => f.type === "missing-lockfile")!.severity).toBe("MEDIUM");
    expect(res.findings.find((f) => f.evidence.includes("`d`"))!.severity).toBe("INFO");
    const priv = res.dependencies.find((d) => d.name === "priv")!;
    expect(priv.versionSpec).toBe("git+https://<redacted>@git.example.com/org/priv.git");
    expect(JSON.stringify(res)).not.toContain("hunter2");
    expect(redactSpec("https://user:pw@host/x")).toBe("https://<redacted>@host/x");
  });

  it("resolves npm workspaces against the root lockfile, preferring nested installs", async () => {
    const res = await analyzeRepo({
      "package.json": json({ name: "root", private: true, workspaces: ["packages/*"] }),
      "packages/web/package.json": json({ name: "@shop/web", dependencies: { "@shop/utils": "*", react: "^18.2.0" } }),
      "packages/utils/package.json": json({ name: "@shop/utils", dependencies: { react: "^18.0.0" } }),
      "package-lock.json": json({
        lockfileVersion: 3,
        packages: {
          "": { name: "root" },
          "node_modules/react": { version: "18.2.0" },
          "packages/web/node_modules/react": { version: "18.3.1" },
          "node_modules/@shop/utils": { link: true, resolved: "packages/utils" },
        },
      }),
    });
    const reactIn = (p: string) => res.dependencies.find((d) => d.name === "react" && d.manifestPath === p)?.resolvedVersion;
    expect(reactIn("packages/web/package.json")).toBe("18.3.1");
    expect(reactIn("packages/utils/package.json")).toBe("18.2.0");
    expect(res.dependencies.find((d) => d.name === "@shop/utils")!.source).toBe("workspace");
    // Both locked react versions are claimed by a manifest, so no transitive duplicates remain.
    expect(res.dependencies.filter((d) => !d.direct)).toEqual([]);
    expect(res.findings).toEqual([]);
  });

  it("matches yarn.lock and pnpm-lock.yaml entries to direct dependencies", async () => {
    const yarn = await analyzeRepo({
      "package.json": json({ name: "y", dependencies: { lodash: "^4.17.0" } }),
      "yarn.lock": 'lodash@^4.17.0:\n  version "4.17.21"\n\nms@^2.1.0:\n  version "2.1.3"\n',
    });
    expect(yarn.dependencies.map((d) => [d.name, d.resolvedVersion, d.direct])).toEqual([
      ["lodash", "4.17.21", true],
      ["ms", "2.1.3", false],
    ]);
    const pnpm = await analyzeRepo({
      "package.json": json({ name: "p", dependencies: { lodash: "^4.17.0" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4.17.0\n        version: 4.17.21\n\npackages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-x}\n",
    });
    expect(pnpm.dependencies.map((d) => [d.name, d.resolvedVersion, d.direct])).toEqual([["lodash", "4.17.21", true]]);
  });

  it("reads a text bun.lock like any other npm lockfile", async () => {
    const res = await analyzeRepo({
      "package.json": json({ name: "b", dependencies: { lodash: "^4.17.0" } }),
      "bun.lock": [
        "{",
        '  "lockfileVersion": 1,',
        '  "workspaces": {',
        '    "": { "name": "b", "dependencies": { "lodash": "^4.17.0", }, },',
        "  },",
        '  "packages": {',
        '    "lodash": ["lodash@4.17.21", "", {}, "sha512-x"],',
        '    "ms": ["ms@2.1.3", "", {}, "sha512-y"],',
        "  },",
        "}",
      ].join("\n"),
    });
    expect(res.dependencies.map((d) => [d.name, d.resolvedVersion, d.direct])).toEqual([
      ["lodash", "4.17.21", true],
      ["ms", "2.1.3", false],
    ]);
    expect(res.findings).toEqual([]);
  });

  it("does not report a missing lockfile when only a binary bun.lockb exists", async () => {
    const res = await analyzeRepo({
      "package.json": json({ name: "b", dependencies: { lodash: "^4.17.0" } }),
      "bun.lockb": "\u0000\u0001binary-lockfile\u0000",
    });
    expect(res.findings.filter((f) => f.type === "missing-lockfile")).toEqual([]);
  });

  it("resolves Poetry projects through poetry.lock and lists transitive packages", async () => {
    const res = await analyzeRepo({
      "pyproject.toml": [
        "[tool.poetry.dependencies]",
        'python = "^3.11"',
        'Django = "^4.2"',
        'mylib = { path = "../mylib" }',
        "[tool.poetry.group.dev.dependencies]",
        'pytest = "^8.0"',
      ].join("\n"),
      "poetry.lock": [
        "[[package]]",
        'name = "django"',
        'version = "4.2.1"',
        "",
        "[[package]]",
        'name = "sqlparse"',
        'version = "0.4.4"',
        "",
        "[[package]]",
        'name = "pytest"',
        'version = "8.1.0"',
        'category = "dev"',
      ].join("\n"),
    });
    expect(res.dependencies.map((d) => [d.name, d.resolvedVersion, d.direct, d.dev]).sort()).toEqual([
      ["django", "4.2.1", true, false],
      ["mylib", null, true, false],
      ["pytest", "8.1.0", true, true],
      ["sqlparse", "0.4.4", false, false],
    ]);
  });

  it("queries PyPI, Maven, Go and crates.io packages and flags a missing Pipfile.lock", async () => {
    const osv = fakeOsv({
      vulns: { "requests@2.19.0": ["PYSEC-2018-28"] },
      advisories: { "PYSEC-2018-28": advisory("PYSEC-2018-28", "PyPI", "requests", "2.20.0", { database_specific: { severity: "HIGH" } }) },
    });
    const res = await analyzeRepo(
      {
        "requirements.txt": "requests==2.19.0\nflask>=2\n",
        "svc/Pipfile": '[packages]\nrequests = "*"\n',
        "java/pom.xml": "<project><dependencies><dependency><groupId>g</groupId><artifactId>a</artifactId><version>1.0</version></dependency></dependencies></project>",
        "go/go.mod": "module m\n\nrequire github.com/pkg/errors v0.9.1\n",
        "rs/Cargo.toml": '[dependencies]\nserde = "1.0"\n',
        "rs/Cargo.lock": '[[package]]\nname = "serde"\nversion = "1.0.190"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n',
      },
      { osv: { fetch: osv.fetch } },
    );
    const sent = (osv.requests[0]!.body as { queries: Array<{ package: { ecosystem: string; name: string }; version: string }> }).queries;
    expect(sent.map((q) => `${q.package.ecosystem}:${q.package.name}@${q.version}`).sort()).toEqual([
      "Go:github.com/pkg/errors@0.9.1",
      "Maven:g:a@1.0",
      "PyPI:requests@2.19.0",
      "crates.io:serde@1.0.190",
    ]);
    const vuln = res.findings.find((f) => f.type === "vulnerable-dependency")!;
    expect(vuln).toMatchObject({ path: "requirements.txt", line: 1, severity: "HIGH" });
    expect(vuln.recommendation).toBe("Upgrade requests to 2.20.0 or later.");
    expect(res.findings.find((f) => f.type === "missing-lockfile")).toMatchObject({ path: "svc/Pipfile", severity: "LOW" });
    expect(res.summary.byEcosystem.map((e) => e.ecosystem).sort()).toEqual(["Go", "Maven", "PyPI", "crates.io"]);
  });

  it("flags runtime npm dependencies that no file imports", async () => {
    const res = await analyzeRepo(
      {
        "package.json": json({
          name: "u",
          scripts: { lint: "eslint ." },
          dependencies: { lodash: "^4.17.0", chalk: "^5.0.0", "react-dom": "^19.0.0", eslint: "^9.0.0", tailwindcss: "^4.0.0", "@shop/ui": "^1.0.0" },
        }),
        "package-lock.json": json({ lockfileVersion: 3, packages: { "": {} } }),
        "postcss.config.mjs": 'export default { plugins: { "tailwindcss": {} } };\n',
        "src/index.ts": 'import fp from "lodash/fp";\nimport ui from "@shop/ui/button";\n',
      },
      {
        imports: [
          { path: "src/index.ts", language: "typescript", imports: ["lodash/fp", "@shop/ui/button", "./local", "node:fs"] },
          { path: "scripts/build.py", language: "python", imports: ["chalk"] },
        ],
      },
    );
    const unused = res.findings.filter((f) => f.type === "unused-dependency");
    expect(unused.map((f) => f.evidence.match(/^`([^`]+)`/)?.[1])).toEqual(["chalk"]);
    expect(unused[0]).toMatchObject({ severity: "INFO", path: "package.json" });
    expect(res.dependencies.find((d) => d.name === "chalk")!.unusedCandidate).toBe(true);
    expect(res.summary.totals.unusedCandidates).toBe(1);
  });

  it("produces stable, unique fingerprints and caps stored findings", async () => {
    const files = {
      "package.json": json({ name: "x", dependencies: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p${i}`, "*"])) }),
    };
    const a = await analyzeRepo(files);
    const b = await analyzeRepo(files);
    expect(a.findings.map((f) => f.fingerprint)).toEqual(b.findings.map((f) => f.fingerprint));
    expect(new Set(a.findings.map((f) => f.fingerprint)).size).toBe(a.findings.length);

    const capped = await analyzeRepo(files, { maxFindings: 5, maxDependencies: 3 });
    expect(capped.findings).toHaveLength(5);
    expect(capped.summary.findings).toMatchObject({ total: 13, stored: 5, truncated: true });
    expect(capped.dependencies).toHaveLength(3);
    expect(capped.summary.dependencies).toEqual({ total: 12, stored: 3, truncated: true });
  });

  it("returns an empty result for repositories without manifests", async () => {
    const res = await analyzeRepo({ "src/main.c": "int main(void) { return 0; }\n" }, { osv: { fetch: fakeOsv({}).fetch } });
    expect(res.dependencies).toEqual([]);
    expect(res.findings).toEqual([]);
    expect(res.summary.vulnerabilityScan.status).toBe("skipped");
  });
});

// ------------------------------------------------------------------ private registries

describe("private npm registries", () => {
  const TOKEN = ["npm", "Tk8m".repeat(9)].join("_");

  it("recognises the public registries and nothing else", () => {
    expect(isPublicNpmRegistry("https://registry.npmjs.org")).toBe(true);
    expect(isPublicNpmRegistry("https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz")).toBe(true);
    expect(isPublicNpmRegistry("https://registry.yarnpkg.com/")).toBe(true);
    expect(isPublicNpmRegistry("https://npm.corp.example/")).toBe(false);
    expect(isPublicNpmRegistry("http://registry.npmjs.org/")).toBe(false);
    expect(isPublicNpmRegistry("${NPM_REGISTRY}")).toBe(false);
  });

  it("reads registry lines from .npmrc and .yarnrc.yml and nothing else", () => {
    const npmrc = parseNpmRegistryConfig(
      ".npmrc",
      ["# corp", "registry=https://npm.corp.example/", '@acme:registry = "https://acme.example/npm/"', `//npm.corp.example/:_authToken=${TOKEN}`, "; comment", "save-exact=true"].join("\n"),
    );
    expect(npmrc.registry).toBe("https://npm.corp.example/");
    expect([...npmrc.scopes]).toEqual([["@acme", "https://acme.example/npm/"]]);
    expect(JSON.stringify([npmrc.registry, [...npmrc.scopes]])).not.toContain(TOKEN);

    const yarnrc = parseNpmRegistryConfig(
      ".yarnrc.yml",
      [
        "nodeLinker: node-modules",
        'npmRegistryServer: "https://registry.yarnpkg.com"',
        "npmScopes:",
        "  corp:",
        '    npmRegistryServer: "https://npm.corp.example"',
        `    npmAuthToken: "${TOKEN}"`,
        "  other:",
        "    npmAlwaysAuth: true",
      ].join("\n"),
    );
    expect(yarnrc.registry).toBe("https://registry.yarnpkg.com");
    expect([...yarnrc.scopes]).toEqual([["@corp", "https://npm.corp.example"]]);
  });

  it("records where lockfile entries came from", () => {
    const npmLock = parsePackageLock(
      json({ lockfileVersion: 3, packages: { "node_modules/a": { version: "1.0.0", resolved: "https://npm.corp.example/a/-/a-1.0.0.tgz" }, "node_modules/b": { version: "1.0.0" } } }),
    );
    expect(npmLock.map((l) => [l.name, l.publicRegistry, l.registryRecorded])).toEqual([
      ["a", false, true],
      ["b", true, false],
    ]);

    const yarnClassic = parseYarnLock(
      [
        "lodash@^4.17.0:",
        '  version "4.17.21"',
        '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#abc"',
        "",
        '"@corp/ui@^1.0.0":',
        '  version "1.2.0"',
        '  resolved "https://npm.corp.example/@corp/ui/-/ui-1.2.0.tgz#def"',
        "  dependencies:",
        '    lodash "^4.17.0"',
      ].join("\n"),
    );
    expect(yarnClassic.map((l) => [l.name, l.version, l.publicRegistry, l.registryRecorded])).toEqual([
      ["lodash", "4.17.21", true, true],
      ["@corp/ui", "1.2.0", false, true],
    ]);
    const berry = parseYarnLock('"lodash@npm:^4.17.0":\n  version: 4.17.21\n  resolution: "lodash@npm:4.17.21"\n');
    expect(berry.map((l) => [l.name, l.registryRecorded])).toEqual([["lodash", false]]);

    const pnpm = parsePnpmLock(
      [
        "lockfileVersion: '9.0'",
        "",
        "packages:",
        "",
        "  lodash@4.17.21:",
        "    resolution: {integrity: sha512-x}",
        "",
        "  '@corp/ui@1.2.0':",
        "    resolution: {integrity: sha512-y, tarball: https://npm.corp.example/@corp/ui/-/ui-1.2.0.tgz}",
        "",
        "  other@2.0.0:",
        "    resolution:",
        "      integrity: sha512-z",
        "      tarball: https://registry.npmjs.org/other/-/other-2.0.0.tgz",
      ].join("\n"),
    ).packages;
    expect(pnpm.map((l) => [l.name, l.publicRegistry, l.registryRecorded])).toEqual([
      ["lodash", true, false],
      ["@corp/ui", false, true],
      ["other", true, true],
    ]);

    const bun = parseBunLock('{ "packages": { "a": ["a@1.0.0", "", {}, "x"], "b": ["b@1.0.0", "https://npm.corp.example/", {}, "y"] } }');
    expect(bun.map((l) => [l.name, l.publicRegistry, l.registryRecorded])).toEqual([
      ["a", true, false],
      ["b", false, true],
    ]);
  });

  /** Package names sent to OSV.dev for a repository. */
  const sentFor = async (files: Record<string, string>) => {
    const osv = fakeOsv({});
    const res = await analyzeRepo(files, { osv: { fetch: osv.fetch } });
    const names = osv.requests
      .filter((r) => r.url.endsWith("/querybatch"))
      .flatMap((r) => (r.body as { queries: Array<{ package: { name: string } }> }).queries.map((q) => q.package.name))
      .sort();
    return { names, res };
  };
  const pkg = (deps: Record<string, string>, name = "app") => json({ name, dependencies: deps });
  const PNPM_LODASH =
    "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4.17.0\n        version: 4.17.21\n\npackages:\n\n  lodash@4.17.21:\n    resolution: {integrity: sha512-x}\n";

  it("withholds yarn.lock (classic) packages resolved from a private registry", async () => {
    const { names } = await sentFor({
      "package.json": pkg({ lodash: "^4.17.0", "@corp/ui": "^1.0.0" }),
      "yarn.lock": [
        "lodash@^4.17.0:",
        '  version "4.17.21"',
        '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#abc"',
        "",
        '"@corp/ui@^1.0.0":',
        '  version "1.2.0"',
        '  resolved "https://npm.corp.example/@corp/ui/-/ui-1.2.0.tgz#def"',
      ].join("\n"),
    });
    expect(names).toEqual(["lodash"]);
  });

  it("withholds pnpm packages with a private tarball URL", async () => {
    const { names } = await sentFor({
      "package.json": pkg({ lodash: "^4.17.0", "@corp/ui": "^1.0.0" }),
      "pnpm-lock.yaml": [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .:",
        "    dependencies:",
        "      lodash:",
        "        specifier: ^4.17.0",
        "        version: 4.17.21",
        "      '@corp/ui':",
        "        specifier: ^1.0.0",
        "        version: 1.2.0",
        "",
        "packages:",
        "",
        "  lodash@4.17.21:",
        "    resolution: {integrity: sha512-x}",
        "",
        "  '@corp/ui@1.2.0':",
        "    resolution: {integrity: sha512-y, tarball: https://npm.corp.example/@corp/ui/-/ui-1.2.0.tgz}",
      ].join("\n"),
    });
    expect(names).toEqual(["lodash"]);
  });

  it("uses .yarnrc.yml scopes for Yarn Berry, which does not record registries", async () => {
    const { names } = await sentFor({
      "package.json": pkg({ lodash: "^4.17.0", "@corp/ui": "^1.0.0" }),
      ".yarnrc.yml": 'npmScopes:\n  corp:\n    npmRegistryServer: "https://npm.corp.example"\n',
      "yarn.lock": ["__metadata:", "  version: 6", "", '"lodash@npm:^4.17.0":', "  version: 4.17.21", "", '"@corp/ui@npm:^1.0.0":', "  version: 1.2.0"].join("\n"),
    });
    expect(names).toEqual(["lodash"]);
  });

  it("treats every unrecorded package as private when .npmrc sets a private default registry", async () => {
    const files = { "package.json": pkg({ lodash: "^4.17.0", pinned: "1.0.0" }), "pnpm-lock.yaml": PNPM_LODASH };
    expect((await sentFor(files)).names).toEqual(["lodash", "pinned"]);
    const { names, res } = await sentFor({ ...files, ".npmrc": `registry=https://npm.corp.example/\n//npm.corp.example/:_authToken=${TOKEN}\n` });
    expect(names).toEqual([]);
    expect(res.summary.vulnerabilityScan.status).toBe("skipped");
    expect(JSON.stringify(res)).not.toContain(TOKEN);
    // A registry taken from an environment variable cannot be checked, so it counts as private.
    expect((await sentFor({ ...files, ".npmrc": "registry=${NPM_REGISTRY}\n" })).names).toEqual([]);
  });

  it("applies a .npmrc only to its own directory and below", async () => {
    const { names } = await sentFor({
      "package.json": pkg({ "pinned-public": "1.0.0" }, "root"),
      "internal/package.json": pkg({ "pinned-internal": "2.0.0" }, "internal"),
      "internal/.npmrc": "registry=https://npm.corp.example/\n",
    });
    expect(names).toEqual(["pinned-public"]);
  });

  it("keeps a recorded public registry even when a scope is configured elsewhere", async () => {
    const { names } = await sentFor({
      "package.json": pkg({ "@corp/ui": "^1.0.0" }),
      ".npmrc": "@corp:registry=https://npm.corp.example/\n",
      "package-lock.json": json({
        lockfileVersion: 3,
        packages: { "node_modules/@corp/ui": { version: "1.2.0", resolved: "https://registry.npmjs.org/@corp/ui/-/ui-1.2.0.tgz" } },
      }),
    });
    expect(names).toEqual(["@corp/ui"]);
  });
});
