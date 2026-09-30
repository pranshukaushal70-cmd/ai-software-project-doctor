import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanRepository, type RepositoryScan } from "../src/scanner";
import { classifyFile } from "../src/scanner/classify";
import { pythonDependencyNames } from "../src/scanner/detectors";
import { detectLanguage } from "../src/scanner/languages";

const FIXTURE: Record<string, string | Buffer> = {
  "package.json": JSON.stringify({
    name: "fixture",
    main: "src/server.js",
    scripts: { start: "node src/server.js" },
    dependencies: { express: "^4.18.0", mongoose: "^7.0.0" },
    devDependencies: { jest: "^29.0.0" },
  }),
  "package-lock.json": "{}",
  "README.md": "# Fixture\n",
  ".gitignore": "secret-output/\n*.log\n",
  ".env": "DB_PASSWORD=hunter2\n",
  ".env.example": "DB_PASSWORD=\n",
  "Dockerfile": "FROM node:24\n",
  ".github/workflows/ci.yml": "on: push\n",
  "src/server.js": "const express = require('express');\nconst app = express();\n\napp.listen(3000);\n",
  "src/routes/users.ts": "export const x = 1;\n",
  "src/__tests__/server.test.js": "test('x', () => {});\n",
  "src/logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]),
  "dist/bundle.js": "ignored",
  "node_modules/express/index.js": "ignored",
  "secret-output/data.txt": "gitignored dir",
  "debug.log": "gitignored file",
  "api/app.py": "from flask import Flask\n",
  "requirements.txt": "Flask==3.0.0  # web\npytest>=8\n-r other.txt\n",
};

let root: string;
let scan: RepositoryScan;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "pd-scan-test-"));
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  scan = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scanRepository", () => {
  it("prunes default-ignored and gitignored paths", () => {
    const paths = scan.files.map((f) => f.path);
    expect(paths).not.toContain("dist/bundle.js");
    expect(paths).not.toContain("node_modules/express/index.js");
    expect(paths).not.toContain("secret-output/data.txt");
    expect(paths).not.toContain("debug.log");
    expect(scan.ignored.dirs).toEqual(expect.arrayContaining(["dist", "node_modules", "secret-output"]));
    expect(scan.ignored.gitignoredFiles).toBe(1);
  });

  it("classifies files by kind", () => {
    const kindOf = (p: string) => scan.files.find((f) => f.path === p)?.kind;
    expect(kindOf("src/server.js")).toBe("SOURCE");
    expect(kindOf("src/__tests__/server.test.js")).toBe("TEST");
    expect(kindOf("README.md")).toBe("DOCUMENTATION");
    expect(kindOf("package.json")).toBe("CONFIG");
    expect(kindOf("package-lock.json")).toBe("GENERATED");
    expect(kindOf("src/logo.png")).toBe("BINARY");
    expect(kindOf(".env")).toBe("CONFIG");
  });

  it("counts lines and aggregates languages", () => {
    expect(scan.files.find((f) => f.path === "src/server.js")?.lines).toBe(4);
    const langs = Object.fromEntries(scan.languages.map((l) => [l.language, l.files]));
    expect(langs).toMatchObject({ javascript: 2, typescript: 1, python: 1 });
    expect(scan.primaryLanguage).toBe("javascript");
  });

  it("detects tooling with evidence", () => {
    expect(scan.packageManagers.map((d) => d.name)).toEqual(expect.arrayContaining(["npm", "pip"]));
    const fw = Object.fromEntries(scan.frameworks.map((d) => [d.name, d.evidence]));
    expect(fw.Express).toBe("package.json: dependencies.express");
    expect(fw.Mongoose).toBe("package.json: dependencies.mongoose");
    expect(fw.Jest).toBe("package.json: devDependencies.jest");
    expect(fw.Flask).toBe("requirements.txt: flask");
    expect(fw.PyTest).toBe("requirements.txt: pytest");
    expect(scan.ci.map((d) => d.name)).toEqual(["GitHub Actions"]);
    expect(scan.containers.map((d) => d.name)).toContain("Dockerfile");
  });

  it("distinguishes committed env files from templates", () => {
    expect(scan.envFiles).toEqual([
      { path: ".env", isTemplate: false },
      { path: ".env.example", isTemplate: true },
    ]);
  });

  it("detects docs and entry points", () => {
    expect(scan.docs).toMatchObject({ readme: "README.md", license: null, contributing: null });
    expect(scan.entryPoints.map((e) => e.evidence)).toEqual(
      expect.arrayContaining(["package.json: main", "package.json: scripts.start"]),
    );
  });

  it("builds a tree with directories first and rolled-up counts", () => {
    expect(scan.tree.fileCount).toBe(scan.files.length);
    const first = scan.tree.children![0]!;
    expect(first.type).toBe("dir");
    const src = scan.tree.children!.find((c) => c.name === "src")!;
    expect(src.fileCount).toBe(4);
  });

  it("returns sorted, deterministic output when the file limit truncates the walk", async () => {
    const limited = await scanRepository(root, { maxFileBytes: 1024 * 1024, maxFiles: 11 });
    expect(limited.ignored.truncated).toBe(true);
    expect(limited.files).toHaveLength(11);
    const paths = limited.files.map((f) => f.path);
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    const again = await scanRepository(root, { maxFileBytes: 1024 * 1024, maxFiles: 11 });
    expect(again.files.map((f) => f.path)).toEqual(paths);
  });
});

describe("helpers", () => {
  it("detects languages by extension and file name", () => {
    expect(detectLanguage("a/b/Component.tsx")).toBe("typescript");
    expect(detectLanguage("lib/util.hpp")).toBe("cpp");
    expect(detectLanguage("Dockerfile.prod")).toBe("dockerfile");
    expect(detectLanguage("CMakeLists.txt")).toBe("cmake");
    expect(detectLanguage("noext")).toBeNull();
  });

  it.each([
    ["src/test/java/com/x/UserServiceTest.java", "java", "TEST"],
    ["tests/test_api.py", "python", "TEST"],
    ["app/models.py", "python", "SOURCE"],
    ["web/app.min.js", "javascript", "GENERATED"],
    ["types/index.d.ts", "typescript", "GENERATED"],
    ["docs/guide.txt", null, "DOCUMENTATION"],
  ])("classifies %s", (p, lang, kind) => {
    expect(classifyFile(p, lang, false)).toBe(kind);
  });

  it("parses requirements.txt names", () => {
    expect(
      pythonDependencyNames("requirements.txt", "Django>=4\nrequests[socks]==2.0\n# comment\n-e .\nzope.interface\n"),
    ).toEqual(["django", "requests", "zope-interface"]);
  });

  it("parses PEP 621 pyproject dependencies without picking up metadata keys", () => {
    const toml = [
      "[project]",
      'name = "myproj"',
      'version = "0.1.0"',
      "dependencies = [",
      '  "fastapi>=0.110",',
      '  "SQLAlchemy",',
      "]",
      "[project.optional-dependencies]",
      'dev = ["pytest>=8", "ruff"]',
    ].join("\n");
    expect(pythonDependencyNames("pyproject.toml", toml).sort()).toEqual(["fastapi", "pytest", "ruff", "sqlalchemy"]);
  });

  it("parses Poetry and Pipfile tables, excluding python itself", () => {
    const poetry = '[tool.poetry]\nname = "x"\n[tool.poetry.dependencies]\npython = "^3.11"\nflask = "^3.0"\ncelery = { version = "^5" }\n';
    expect(pythonDependencyNames("pyproject.toml", poetry).sort()).toEqual(["celery", "flask"]);
    const pipfile = '[[source]]\nurl = "https://pypi.org/simple"\n[packages]\ndjango = "*"\n[dev-packages]\npytest = "*"\n';
    expect(pythonDependencyNames("Pipfile", pipfile).sort()).toEqual(["django", "pytest"]);
  });
});
