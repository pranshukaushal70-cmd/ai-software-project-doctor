import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeCode } from "../src/metrics";
import { analyzePractices, parseCoverage, type PracticeFinding } from "../src/practices";
import { scanRepository } from "../src/scanner";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function writeRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pd-practices-test-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

/** Full pipeline on real files: scan → code metrics → practices. */
async function analyze(files: Record<string, string>) {
  const root = await writeRepo(files);
  const scan = await scanRepository(root, { maxFileBytes: 1024 * 1024 });
  const code = await analyzeCode(scan.files);
  return analyzePractices(scan, code, { root });
}

const rules = (findings: PracticeFinding[], ruleId: string) => findings.filter((f) => f.ruleId === ruleId);
/** A README that passes the documentation checks, so tests of other areas are not disturbed by it. */
const GOOD_README = `# Shop\n\n${"This service sells things to people who want them. ".repeat(20)}\n\n## Installation\n\n\`\`\`\nnpm install\n\`\`\`\n\n## Usage\n\n\`\`\`\nnpm start\n\`\`\`\n`;
/** n lines of real code, so code-line thresholds can be crossed. */
const lines = (n: number, name = "v") => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i} + 1;`).join("\n") + "\n";

describe("API analysis", () => {
  const express = `import express from "express";
import cors from "cors";
import { z } from "zod";
import { requireAuth } from "./auth";
const app = express();
app.use(cors({ origin: true, credentials: true }));

app.get("/products", (req, res) => res.json([]));
app.post("/orders", requireAuth, (req, res) => {
  const order = z.object({ sku: z.string() }).parse(req.body);
  res.status(201).json(order);
});
app.delete("/products/:id", (req, res) => {
  res.status(204).end();
});
app.post("/login", (req, res) => {
  res.json({ ok: true });
});
app.use((err, req, res, next) => {
  res.status(500).json({ message: err.message, stack: err.stack });
});
`;

  it("finds Express endpoints with method, path and line, and ignores HTTP client calls", async () => {
    const { summary } = await analyze({
      "src/server.js": express,
      "src/client.js": 'import axios from "axios";\nexport const load = () => axios.get("/products");\n',
    });
    expect(summary.api.list.map((e) => `${e.method} ${e.path} ${e.file}:${e.line}`)).toEqual([
      "POST /login src/server.js:16",
      "POST /orders src/server.js:9",
      "GET /products src/server.js:8",
      "DELETE /products/:id src/server.js:13",
    ]);
    expect(summary.api).toMatchObject({ endpoints: 4, mutating: 3, byMethod: { GET: 1, POST: 2, DELETE: 1 }, frameworks: [{ name: "Express", endpoints: 4 }] });
  });

  it("reports unauthenticated mutations, unvalidated bodies, permissive CORS, stack traces and unthrottled login", async () => {
    const { findings } = await analyze({ "src/server.js": express });
    // DELETE has no auth; POST /orders uses requireAuth; POST /login is public by design.
    expect(rules(findings, "api/unauthenticated-mutation").map((f) => f.data?.route)).toEqual(["/products/:id"]);
    expect(rules(findings, "api/unauthenticated-mutation")[0]).toMatchObject({ category: "API", severity: "LOW", line: 13 });
    // POST /orders parses its body with zod.
    expect(rules(findings, "api/missing-input-validation")).toEqual([]);
    const cors = rules(findings, "api/permissive-cors");
    expect(cors).toHaveLength(1);
    expect(cors[0]).toMatchObject({ severity: "HIGH", line: 6, data: expect.objectContaining({ kind: "reflect", credentials: true, cwe: "CWE-942" }) });
    expect(rules(findings, "api/error-details-exposed")[0]).toMatchObject({ severity: "MEDIUM", line: 20 });
    expect(rules(findings, "api/auth-without-rate-limit")[0]).toMatchObject({ path: "src/server.js", line: 16 });
  });

  it("recognises validation, rate limiting and a wildcard origin without credentials", async () => {
    const { findings, summary } = await analyze({
      "package.json": JSON.stringify({ dependencies: { express: "4", "express-rate-limit": "7" } }),
      "src/server.js": `import express from "express";\nconst app = express();\napp.use(cors({ origin: "*" }));\napp.post("/notes", (req, res) => {\n  db.save(req.body.text);\n  res.end();\n});\napp.post("/login", (req, res) => res.end());\n`,
    });
    expect(rules(findings, "api/missing-input-validation").map((f) => f.data?.route)).toEqual(["/notes"]);
    expect(rules(findings, "api/permissive-cors")[0]).toMatchObject({ severity: "LOW" });
    expect(rules(findings, "api/auth-without-rate-limit")).toEqual([]);
    expect(summary.api.rateLimiting).toContain("package.json");
  });

  it("derives Next.js route-handler paths, skipping route groups, and sees in-handler auth checks", async () => {
    const { summary, findings } = await analyze({
      "app/(shop)/api/orders/[id]/route.ts": `import { requireApiUser } from "@/server/auth";\nexport async function GET() { return Response.json({}); }\nexport const DELETE = async () => {\n  await requireApiUser();\n  return new Response(null);\n};\n`,
      "pages/api/ping.ts": "export default function handler(req, res) { res.end(); }\n",
    });
    expect(summary.api.list.map((e) => `${e.method} ${e.path}`)).toEqual(["DELETE /api/orders/[id]", "GET /api/orders/[id]", "ANY /api/ping"]);
    expect(summary.api.list.every((e) => e.framework === "Next.js")).toBe(true);
    expect(rules(findings, "api/unauthenticated-mutation")).toEqual([]);
  });

  it("finds Flask, FastAPI, Django, Spring and NestJS routes", async () => {
    const { summary } = await analyze({
      "app/views.py": `from flask import Flask\napp = Flask(__name__)\n@app.route("/items", methods=["GET", "POST"])\ndef items():\n    return []\n`,
      "api/main.py": `from fastapi import FastAPI\napp = FastAPI()\n@app.delete("/items/{item_id}")\nasync def remove(item_id: int):\n    return None\n`,
      "shop/urls.py": `from django.urls import path, include\nurlpatterns = [\n    path("cart/", views.cart),\n    path("api/", include("api.urls")),\n]\n`,
      "src/main/java/com/shop/OrderController.java": `package com.shop;\n@RestController\n@RequestMapping("/api/orders")\npublic class OrderController {\n  @GetMapping("/{id}")\n  public Order get() { return null; }\n  @PostMapping\n  public Order create(@RequestBody Order o) { return o; }\n}\n`,
      "src/cats.controller.ts": `import { Controller, Get, Post } from "@nestjs/common";\n@Controller("cats")\nexport class CatsController {\n  @Get(":id")\n  find() {}\n  @Post()\n  create() {}\n}\n`,
    });
    expect(summary.api.list.map((e) => `${e.framework} ${e.method} ${e.path}`).sort()).toEqual(
      [
        "Django ANY /cart",
        "FastAPI DELETE /items/{item_id}",
        "Flask GET /items",
        "Flask POST /items",
        "NestJS GET /cats/:id",
        "NestJS POST /cats",
        "Spring GET /api/orders/{id}",
        "Spring POST /api/orders",
      ].sort(),
    );
  });

  it("does not report missing authentication when it is applied application-wide", async () => {
    const { findings, summary } = await analyze({
      "middleware.ts": `import { getToken } from "next-auth/jwt";\nexport async function middleware(req) { await getToken({ req }); }\n`,
      "app/api/items/route.ts": "export async function POST() { return new Response(null); }\n",
    });
    expect(summary.api.globalAuth).toBe("middleware.ts: Next.js middleware");
    expect(rules(findings, "api/unauthenticated-mutation")).toEqual([]);
  });

  it("asks for a specification only for larger APIs without spec, generator or API docs", async () => {
    const routes = Array.from({ length: 5 }, (_, i) => `app.get("/r${i}", (req, res) => res.end());`).join("\n");
    const server = `import express from "express";\nconst app = express();\n${routes}\n`;
    const without = await analyze({ "src/server.js": server });
    expect(rules(without.findings, "api/no-specification")).toEqual([expect.objectContaining({ path: "", line: null, severity: "LOW" })]);
    const documented = await analyze({ "src/server.js": server, "docs/api.md": "# API\n" });
    expect(rules(documented.findings, "api/no-specification")).toEqual([]);
    const spec = await analyze({ "src/server.js": server, "openapi.yaml": "openapi: 3.0.0\n" });
    expect(spec.summary.api.specFiles).toEqual(["openapi.yaml"]);
    expect(rules(spec.findings, "api/no-specification")).toEqual([]);
  });

  it("flags CORS that reflects origins with credentials in FastAPI and Spring", async () => {
    const { findings } = await analyze({
      "api/main.py": `from fastapi import FastAPI\napp.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True)\n`,
      "src/main/java/Web.java": `class Web { void c(CorsRegistry r) { r.addMapping("/**").allowedOriginPatterns("*").allowCredentials(true); } }\n`,
      "src/main/java/Ok.java": `@CrossOrigin("https://app.example.com")\n@RestController\nclass Ok {}\n`,
    });
    expect(rules(findings, "api/permissive-cors").map((f) => `${f.path} ${f.severity}`).sort()).toEqual(["api/main.py HIGH", "src/main/java/Web.java HIGH"]);
  });
});

describe("database analysis", () => {
  const prisma = (provider: string, index = "") => `datasource db {\n  provider = "${provider}"\n}\n\nmodel User {\n  id    String @id\n  posts Post[]\n}\n\nmodel Post {\n  id       String @id\n  authorId String\n  author   User   @relation(fields: [authorId], references: [id])\n${index}}\n`;

  it("reports Prisma relations without an index, and accepts @@index, @unique and MySQL", async () => {
    const missing = await analyze({ "prisma/schema.prisma": prisma("postgresql"), "prisma/migrations/1_init/migration.sql": "CREATE TABLE x (id int PRIMARY KEY);" });
    expect(rules(missing.findings, "database/unindexed-foreign-key")).toEqual([
      expect.objectContaining({ path: "prisma/schema.prisma", line: 13, severity: "LOW", data: expect.objectContaining({ model: "Post", columns: ["authorid"] }) }),
    ]);
    expect(missing.summary.database).toMatchObject({ detected: true, models: 2, relations: 1, migrations: { tools: ["Prisma Migrate"], files: 1 } });
    const indexed = await analyze({ "prisma/schema.prisma": prisma("postgresql", "  @@index([authorId, id])\n"), "prisma/migrations/1_init/migration.sql": "" });
    expect(rules(indexed.findings, "database/unindexed-foreign-key")).toEqual([]);
    const mysql = await analyze({ "prisma/schema.prisma": prisma("mysql"), "prisma/migrations/1_init/migration.sql": "" });
    expect(rules(mysql.findings, "database/unindexed-foreign-key")).toEqual([]);
  });

  it("reports a Prisma schema without migrations", async () => {
    const { findings } = await analyze({ "prisma/schema.prisma": prisma("postgresql", "  @@index([authorId])\n") });
    expect(rules(findings, "database/no-migrations")).toEqual([expect.objectContaining({ path: "prisma/schema.prisma", data: { orm: "Prisma", models: 2 } })]);
  });

  it("checks SQL DDL for primary keys and foreign-key indexes, ignoring comments", async () => {
    const { findings, summary } = await analyze({
      "db/schema.sql": `-- CREATE TABLE commented (x int);
CREATE TABLE customers (id SERIAL PRIMARY KEY, email TEXT UNIQUE);
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INT REFERENCES customers(id)
);
CREATE TABLE order_items (
  order_id INT,
  sku TEXT,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);
CREATE INDEX order_items_order ON order_items (order_id, sku);
/* CREATE TABLE also_commented (x int); */
`,
      "db/migrations/001_init.sql": "",
    });
    expect(summary.database).toMatchObject({ tables: 3, tablesWithoutPrimaryKey: 1, unindexedForeignKeys: 1 });
    expect(rules(findings, "database/table-without-primary-key")).toEqual([expect.objectContaining({ line: 7, severity: "MEDIUM", data: { table: "order_items" } })]);
    expect(rules(findings, "database/unindexed-foreign-key")).toEqual([expect.objectContaining({ line: 5, data: { table: "orders", columns: ["customer_id"] } })]);
  });

  it("reports SQLAlchemy foreign keys without index=True", async () => {
    const { findings } = await analyze({
      "app/models.py": `from sqlalchemy import Column, ForeignKey, Integer
class Order(Base):
    __tablename__ = "orders"
    id = Column(Integer, primary_key=True)
    customer_id = Column(Integer, ForeignKey("customers.id"))
    shop_id = Column(Integer, ForeignKey("shops.id"), index=True)
`,
      "alembic.ini": "[alembic]\n",
    });
    expect(rules(findings, "database/unindexed-foreign-key").map((f) => `${f.line} ${f.data?.columns}`)).toEqual(["5 customer_id"]);
  });

  it("reports automatic schema synchronisation, except in test configuration", async () => {
    const { findings } = await analyze({
      "src/data-source.ts": `import { DataSource } from "typeorm";\nexport const ds = new DataSource({ type: "postgres", synchronize: true });\n`,
      "src/main/resources/application.properties": "spring.jpa.hibernate.ddl-auto=update\n",
      "src/test/resources/application-test.properties": "spring.jpa.hibernate.ddl-auto=create-drop\n",
    });
    expect(rules(findings, "database/auto-schema-sync").map((f) => `${f.path}:${f.line}`).sort()).toEqual([
      "src/data-source.ts:2",
      "src/main/resources/application.properties:1",
    ]);
  });
});

describe("testing analysis", () => {
  it("reports a repository without tests by size", async () => {
    const small = await analyze({ "src/a.ts": lines(250) });
    expect(rules(small.findings, "testing/no-tests")).toEqual([expect.objectContaining({ severity: "MEDIUM", path: "", line: null })]);
    const tiny = await analyze({ "src/a.ts": lines(50) });
    expect(rules(tiny.findings, "testing/no-tests")).toEqual([]);
  });

  it("counts test cases and reports focused and skipped tests, the test ratio and CI", async () => {
    const { findings, summary } = await analyze({
      "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      "src/orders.ts": lines(400, "o"),
      "src/billing.ts": lines(160, "b"),
      "tests/orders.test.ts": `import { o1 } from "../src/orders";\nit("adds", () => {});\nit.only("focus", () => {});\ntest.skip("later", () => {});\nxit("old", () => {});\n`,
      "tests/test_tools.py": "def test_a():\n    pass\n\n@pytest.mark.skip\ndef test_b():\n    pass\n",
      ".github/workflows/ci.yml": "jobs:\n  build:\n    steps:\n      - run: npm ci\n      - run: npm run build\n",
    });
    expect(summary.testing).toMatchObject({ testFiles: 2, testCases: 6, focused: 1, skipped: 3, ci: { configured: true, runsTests: false } });
    expect(rules(findings, "testing/focused-test")).toEqual([expect.objectContaining({ line: 3, severity: "LOW" })]);
    expect(rules(findings, "testing/skipped-test").map((f) => `${f.path}:${f.line}`)).toEqual(["tests/orders.test.ts:4", "tests/orders.test.ts:5", "tests/test_tools.py:4"]);
    expect(rules(findings, "testing/low-test-ratio")).toEqual([expect.objectContaining({ severity: "MEDIUM" })]);
    expect(rules(findings, "testing/tests-not-in-ci")).toEqual([expect.objectContaining({ path: ".github/workflows/ci.yml" })]);
    expect(rules(findings, "testing/no-test-script")).toEqual([expect.objectContaining({ path: "package.json" })]);
    // orders.ts is imported by a test; billing.ts is large and referenced by none.
    expect(rules(findings, "testing/untested-file").map((f) => f.path)).toEqual(["src/billing.ts"]);
    expect(summary.testing.referencedSourceFiles).toBe(1);
  });

  it("recognises a CI test step and a working test script", async () => {
    const { findings, summary } = await analyze({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/a.ts": lines(30),
      "src/a.test.ts": 'import { v1 } from "./a";\nit("works", () => {});\n',
      ".github/workflows/ci.yml": "steps:\n  - run: npm test\n",
    });
    expect(summary.testing.ci).toEqual({ configured: true, runsTests: true, evidence: ".github/workflows/ci.yml: npm test" });
    expect(summary.testing.testScript).toBe("vitest run");
    expect(findings.filter((f) => f.category === "TESTING")).toEqual([]);
  });

  it("reads a committed coverage report, also from the ignored coverage/ directory", async () => {
    const { findings, summary } = await analyze({
      "src/a.ts": lines(30),
      "src/a.test.ts": 'it("works", () => {});\n',
      "coverage/coverage-summary.json": JSON.stringify({ total: { lines: { total: 100, covered: 42, pct: 42 } } }),
    });
    expect(summary.testing.coverage).toEqual({ path: "coverage/coverage-summary.json", format: "Istanbul", linePercent: 42 });
    expect(rules(findings, "testing/low-coverage")).toEqual([expect.objectContaining({ severity: "MEDIUM", data: expect.objectContaining({ value: 42 }) })]);
  });

  it("parses lcov, Istanbul, Cobertura, JaCoCo and coverage.py reports", () => {
    expect(parseCoverage("lcov.info", "SF:a\nLF:10\nLH:8\nend_of_record\nSF:b\nLF:10\nLH:2\nend_of_record\n")).toEqual({ format: "lcov", linePercent: 50 });
    expect(parseCoverage("coverage-summary.json", '{"total":{"lines":{"pct":87.25}}}')).toEqual({ format: "Istanbul", linePercent: 87.3 });
    expect(parseCoverage("coverage.json", '{"totals":{"percent_covered":91.04}}')).toEqual({ format: "coverage.py", linePercent: 91 });
    expect(parseCoverage("coverage.xml", '<?xml version="1.0"?><coverage line-rate="0.734" branch-rate="0.5">')).toEqual({ format: "Cobertura", linePercent: 73.4 });
    expect(
      parseCoverage("jacoco.xml", '<package><counter type="LINE" missed="1" covered="1"/></package><counter type="LINE" missed="25" covered="75"/></report>'),
    ).toEqual({ format: "JaCoCo", linePercent: 75 });
    expect(parseCoverage("coverage.json", "not json")).toBeNull();
  });
});

describe("documentation analysis", () => {
  it("reports a missing README and license", async () => {
    const { findings } = await analyze({ "src/a.ts": "export const a = 1;\n", "package.json": JSON.stringify({ license: "MIT" }) });
    expect(rules(findings, "documentation/missing-readme")).toEqual([expect.objectContaining({ severity: "MEDIUM", path: "" })]);
    expect(rules(findings, "documentation/missing-license")[0]!.evidence).toContain("package.json: MIT is declared");
  });

  it("reports a thin README without install or usage instructions, and accepts a complete one", async () => {
    const thin = await analyze({ "README.md": "# Shop\n\nA shop.\n", LICENSE: "MIT" });
    const finding = rules(thin.findings, "documentation/incomplete-readme")[0]!;
    expect(finding.evidence).toContain("only 3 words");
    expect(finding.evidence).toContain("how to install");
    expect(finding.evidence).toContain("how to run or use it");
    const good = await analyze({ "README.md": GOOD_README, LICENSE: "MIT" });
    expect(good.findings.filter((f) => f.category === "DOCUMENTATION")).toEqual([]);
    expect(good.summary.documentation.readme?.sections).toMatchObject({ installation: true, usage: true });
  });

  it("lists environment variables the code reads that no template or doc mentions", async () => {
    const { findings, summary } = await analyze({
      "README.md": GOOD_README,
      LICENSE: "MIT",
      ".env.example": "DATABASE_URL=postgres://localhost/shop\n",
      "src/config.ts": `export const db = process.env.DATABASE_URL;\nexport const key = process.env.STRIPE_SECRET_KEY;\nexport const mode = process.env.NODE_ENV;\nconst { SMTP_HOST, SMTP_PORT = "25" } = process.env;\n`,
      "app/settings.py": 'import os\nSENTRY_DSN = os.environ.get("SENTRY_DSN")\n',
    });
    expect(summary.documentation.envVars).toEqual({ used: 5, documented: 1, undocumented: ["SENTRY_DSN", "SMTP_HOST", "SMTP_PORT", "STRIPE_SECRET_KEY"], templates: [".env.example"] });
    // Located at the first undocumented read, in path order.
    const f = rules(findings, "documentation/undocumented-env-vars")[0]!;
    expect(f).toMatchObject({ path: "app/settings.py", line: 2, severity: "LOW" });
    expect(f.evidence).toContain("`STRIPE_SECRET_KEY`");
    expect(f.evidence).not.toContain("DATABASE_URL");
  });

  it("reports relative Markdown links to missing files, ignoring URLs, anchors and code blocks", async () => {
    const { findings, summary } = await analyze({
      "README.md": `${GOOD_README}\nSee [setup](docs/setup.md), [api](docs/api.md#auth), [site](https://example.com), [top](#usage), [src](src/).\n\n\`\`\`\n[not a link](missing.md)\n\`\`\`\n`,
      LICENSE: "MIT",
      "docs/api.md": "Back to [readme](../README.md) and [guide](./guide.md).\n",
      "src/a.ts": "export const a = 1;\n",
    });
    expect(rules(findings, "documentation/broken-link").map((f) => `${f.path}:${f.line} ${f.data?.resolved}`)).toEqual([
      "docs/api.md:1 docs/guide.md",
      "README.md:17 docs/setup.md",
    ]);
    expect(summary.documentation.links).toEqual({ checked: 5, broken: 2 });
  });
});

describe("practices findings", () => {
  it("are fingerprinted uniquely, most severe first, with category, analyzer and version", async () => {
    const { findings, summary } = await analyze({ "src/server.js": `import express from "express";\nconst app = express();\napp.delete("/a", (req, res) => res.end());\napp.delete("/b", (req, res) => res.end());\n` });
    expect(new Set(findings.map((f) => f.fingerprint)).size).toBe(findings.length);
    expect(findings.every((f) => f.analyzer === "practices" && f.analyzerVersion && ["API", "DATABASE", "TESTING", "DOCUMENTATION"].includes(f.category))).toBe(true);
    const order = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
    expect(findings.map((f) => order.indexOf(f.severity))).toEqual([...findings.map((f) => order.indexOf(f.severity))].sort((a, b) => a - b));
    expect(summary.findings.byCategory.API).toBe(2);
    expect(summary.findings.total).toBe(findings.length);
  });

  it("gives the same fingerprints to the same findings in a re-analysis", async () => {
    const files = { "src/server.js": `import express from "express";\nconst app = express();\napp.delete("/a", (req, res) => res.end());\n` };
    const a = await analyze(files);
    const b = await analyze({ ...files, "src/other.js": "export const x = 1;\n" });
    const fp = (r: typeof a) => rules(r.findings, "api/unauthenticated-mutation").map((f) => f.fingerprint);
    expect(fp(b)).toEqual(fp(a));
  });
});
