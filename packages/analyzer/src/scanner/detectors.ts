/**
 * Tooling detection. Every detection carries the evidence (file + key) it
 * was derived from so the UI and AI layer can cite it.
 */

export interface Detection {
  name: string;
  category: string;
  evidence: string;
}

export interface ManifestReader {
  /** Paths of all files in the repository (posix, relative). */
  paths: readonly string[];
  /** Read a small text file; returns null when missing/unreadable/too large. */
  read(relPath: string): Promise<string | null>;
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const depth = (p: string) => p.split("/").length - 1;

function uniqueByName(items: Detection[]): Detection[] {
  const seen = new Map<string, Detection>();
  for (const item of items) if (!seen.has(item.name)) seen.set(item.name, item);
  return [...seen.values()];
}

// ---------------------------------------------------------------- package managers & build systems

const MANAGER_FILES: Array<{ file: RegExp; name: string; category: "package-manager" | "build-system" }> = [
  { file: /^package-lock\.json$/, name: "npm", category: "package-manager" },
  { file: /^yarn\.lock$/, name: "yarn", category: "package-manager" },
  { file: /^pnpm-lock\.yaml$/, name: "pnpm", category: "package-manager" },
  { file: /^bun\.lockb?$/, name: "bun", category: "package-manager" },
  { file: /^requirements[^/]*\.txt$/, name: "pip", category: "package-manager" },
  { file: /^Pipfile$/, name: "pipenv", category: "package-manager" },
  { file: /^poetry\.lock$/, name: "poetry", category: "package-manager" },
  { file: /^pom\.xml$/, name: "Maven", category: "build-system" },
  { file: /^build\.gradle(\.kts)?$/, name: "Gradle", category: "build-system" },
  { file: /^CMakeLists\.txt$/, name: "CMake", category: "build-system" },
  { file: /^(GNU)?[Mm]akefile$/, name: "Make", category: "build-system" },
  { file: /^meson\.build$/, name: "Meson", category: "build-system" },
  { file: /^go\.mod$/, name: "Go modules", category: "package-manager" },
  { file: /^Cargo\.toml$/, name: "Cargo", category: "package-manager" },
];

export function detectPackageManagers(paths: readonly string[]): { packageManagers: Detection[]; buildSystems: Detection[] } {
  const found: Detection[] = [];
  for (const p of paths) {
    const base = basename(p);
    for (const rule of MANAGER_FILES) {
      if (rule.file.test(base)) found.push({ name: rule.name, category: rule.category, evidence: p });
    }
  }
  // A package.json without a lockfile still implies npm-compatible tooling.
  if (!found.some((d) => ["npm", "yarn", "pnpm", "bun"].includes(d.name))) {
    const pkg = paths.find((p) => basename(p) === "package.json");
    if (pkg) found.push({ name: "npm", category: "package-manager", evidence: `${pkg} (no lockfile)` });
  }
  const unique = uniqueByName(found);
  return {
    packageManagers: unique.filter((d) => d.category === "package-manager"),
    buildSystems: unique.filter((d) => d.category === "build-system"),
  };
}

// ---------------------------------------------------------------- frameworks & libraries

const NPM_FRAMEWORKS: Record<string, { name: string; category: string }> = {
  next: { name: "Next.js", category: "web-framework" },
  react: { name: "React", category: "ui" },
  vue: { name: "Vue", category: "ui" },
  "@angular/core": { name: "Angular", category: "ui" },
  svelte: { name: "Svelte", category: "ui" },
  nuxt: { name: "Nuxt", category: "web-framework" },
  express: { name: "Express", category: "web-framework" },
  fastify: { name: "Fastify", category: "web-framework" },
  koa: { name: "Koa", category: "web-framework" },
  "@nestjs/core": { name: "NestJS", category: "web-framework" },
  "@hapi/hapi": { name: "hapi", category: "web-framework" },
  mongoose: { name: "Mongoose", category: "database" },
  "@prisma/client": { name: "Prisma", category: "database" },
  prisma: { name: "Prisma", category: "database" },
  sequelize: { name: "Sequelize", category: "database" },
  typeorm: { name: "TypeORM", category: "database" },
  "drizzle-orm": { name: "Drizzle", category: "database" },
  knex: { name: "Knex", category: "database" },
  pg: { name: "PostgreSQL (pg)", category: "database" },
  mysql2: { name: "MySQL", category: "database" },
  mysql: { name: "MySQL", category: "database" },
  sqlite3: { name: "SQLite", category: "database" },
  "better-sqlite3": { name: "SQLite", category: "database" },
  mongodb: { name: "MongoDB driver", category: "database" },
  redis: { name: "Redis", category: "database" },
  ioredis: { name: "Redis", category: "database" },
  jest: { name: "Jest", category: "testing" },
  vitest: { name: "Vitest", category: "testing" },
  mocha: { name: "Mocha", category: "testing" },
  cypress: { name: "Cypress", category: "testing" },
  "@playwright/test": { name: "Playwright", category: "testing" },
  "@testing-library/react": { name: "Testing Library", category: "testing" },
  typescript: { name: "TypeScript", category: "language-tooling" },
  eslint: { name: "ESLint", category: "linting" },
  prettier: { name: "Prettier", category: "linting" },
  vite: { name: "Vite", category: "bundler" },
  webpack: { name: "webpack", category: "bundler" },
  "socket.io": { name: "Socket.IO", category: "realtime" },
  graphql: { name: "GraphQL", category: "api" },
  "@apollo/server": { name: "Apollo Server", category: "api" },
};

const PY_FRAMEWORKS: Record<string, { name: string; category: string }> = {
  django: { name: "Django", category: "web-framework" },
  flask: { name: "Flask", category: "web-framework" },
  fastapi: { name: "FastAPI", category: "web-framework" },
  starlette: { name: "Starlette", category: "web-framework" },
  sqlalchemy: { name: "SQLAlchemy", category: "database" },
  "psycopg2": { name: "PostgreSQL (psycopg2)", category: "database" },
  "psycopg2-binary": { name: "PostgreSQL (psycopg2)", category: "database" },
  pymongo: { name: "MongoDB driver", category: "database" },
  pytest: { name: "PyTest", category: "testing" },
  celery: { name: "Celery", category: "jobs" },
  pydantic: { name: "Pydantic", category: "validation" },
};

const JVM_FRAMEWORKS: Array<{ re: RegExp; name: string; category: string }> = [
  { re: /spring-boot/, name: "Spring Boot", category: "web-framework" },
  { re: /spring-webmvc|spring-web\b/, name: "Spring MVC", category: "web-framework" },
  { re: /hibernate|jakarta\.persistence|javax\.persistence|spring-boot-starter-data-jpa/, name: "Hibernate/JPA", category: "database" },
  { re: /junit/, name: "JUnit", category: "testing" },
  { re: /mockito/, name: "Mockito", category: "testing" },
];

function parseJson(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function npmDependencyNames(pkg: Record<string, unknown>): Array<{ name: string; field: string }> {
  const out: Array<{ name: string; field: string }> = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = pkg[field];
    if (deps && typeof deps === "object") for (const name of Object.keys(deps)) out.push({ name, field });
  }
  return out;
}

const normalizePyName = (name: string) => name.toLowerCase().replace(/[_.]/g, "-");
const PEP508_NAME = /^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/;

/** Extract package names from a requirements.txt file. */
export function requirementsDependencyNames(text: string): string[] {
  const names = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*|^#.*/, "").trim();
    if (!line || line.startsWith("-") || /^[a-z+]+:\/\//i.test(line)) continue;
    const m = PEP508_NAME.exec(line);
    if (m) names.add(normalizePyName(m[1]!));
  }
  return [...names];
}

/**
 * Extract dependency names from pyproject.toml (PEP 621 and Poetry) or a Pipfile.
 * Section-aware so that keys such as `name = "..."` are not mistaken for packages.
 */
export function tomlDependencyNames(text: string): string[] {
  const names = new Set<string>();
  let section = "";
  let inArray = false;
  const keyTables = /^(tool\.poetry\.(dev-)?dependencies|tool\.poetry\.group\.[^.]+\.dependencies|packages|dev-packages)$/;
  const arrayTables = /^(project|project\.optional-dependencies|dependency-groups)$/;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s#.*|^#.*/, "").trim();
    if (!line) continue;
    const header = /^\[{1,2}\s*([^\]]+?)\s*\]{1,2}$/.exec(line);
    if (header && !inArray) {
      section = header[1]!;
      continue;
    }
    if (inArray) {
      for (const item of line.matchAll(/["']([^"']+)["']/g)) {
        const m = PEP508_NAME.exec(item[1]!);
        if (m) names.add(normalizePyName(m[1]!));
      }
      if (line.includes("]")) inArray = false;
      continue;
    }
    const kv = /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv as unknown as [string, string, string];
    if (keyTables.test(section)) {
      if (key.toLowerCase() !== "python") names.add(normalizePyName(key));
    } else if (arrayTables.test(section) && (section !== "project" || key === "dependencies") && value.startsWith("[")) {
      for (const item of value.matchAll(/["']([^"']+)["']/g)) {
        const m = PEP508_NAME.exec(item[1]!);
        if (m) names.add(normalizePyName(m[1]!));
      }
      inArray = !value.includes("]");
    }
  }
  return [...names];
}

export function pythonDependencyNames(fileName: string, text: string): string[] {
  return /\.txt$/.test(fileName) ? requirementsDependencyNames(text) : tomlDependencyNames(text);
}

export async function detectFrameworks(reader: ManifestReader): Promise<Detection[]> {
  const found: Detection[] = [];
  const manifests = reader.paths.filter((p) => depth(p) <= 3);

  for (const p of manifests.filter((p) => basename(p) === "package.json")) {
    const pkg = parseJson(await reader.read(p));
    if (!pkg) continue;
    for (const { name, field } of npmDependencyNames(pkg)) {
      const fw = NPM_FRAMEWORKS[name];
      if (fw) found.push({ ...fw, evidence: `${p}: ${field}.${name}` });
    }
  }

  for (const p of manifests.filter((p) => /^(requirements[^/]*\.txt|pyproject\.toml|Pipfile)$/.test(basename(p)))) {
    const text = await reader.read(p);
    if (!text) continue;
    for (const dep of pythonDependencyNames(basename(p), text)) {
      const fw = PY_FRAMEWORKS[dep];
      if (fw) found.push({ ...fw, evidence: `${p}: ${dep}` });
    }
  }

  for (const p of manifests.filter((p) => /^(pom\.xml|build\.gradle(\.kts)?)$/.test(basename(p)))) {
    const text = await reader.read(p);
    if (!text) continue;
    for (const rule of JVM_FRAMEWORKS) {
      const m = rule.re.exec(text);
      if (m) found.push({ name: rule.name, category: rule.category, evidence: `${p}: ${m[0]}` });
    }
  }

  if (reader.paths.some((p) => basename(p) === "manage.py")) {
    found.push({ name: "Django", category: "web-framework", evidence: "manage.py present" });
  }
  if (reader.paths.some((p) => p.endsWith("schema.prisma"))) {
    found.push({ name: "Prisma", category: "database", evidence: reader.paths.find((p) => p.endsWith("schema.prisma"))! });
  }
  return uniqueByName(found);
}

// ---------------------------------------------------------------- CI/CD, containers, env files, docs

export function detectCi(paths: readonly string[]): Detection[] {
  const rules: Array<{ re: RegExp; name: string }> = [
    { re: /^\.github\/workflows\/[^/]+\.ya?ml$/, name: "GitHub Actions" },
    { re: /^\.gitlab-ci\.yml$/, name: "GitLab CI" },
    { re: /^Jenkinsfile$/, name: "Jenkins" },
    { re: /^\.circleci\/config\.yml$/, name: "CircleCI" },
    { re: /^azure-pipelines\.yml$/, name: "Azure Pipelines" },
    { re: /^\.travis\.yml$/, name: "Travis CI" },
    { re: /^bitbucket-pipelines\.yml$/, name: "Bitbucket Pipelines" },
  ];
  const found: Detection[] = [];
  for (const p of paths) for (const r of rules) if (r.re.test(p)) found.push({ name: r.name, category: "ci", evidence: p });
  return uniqueByName(found);
}

export function detectContainers(paths: readonly string[]): Detection[] {
  const found: Detection[] = [];
  for (const p of paths) {
    const base = basename(p);
    if (/^Dockerfile(\..+)?$|\.dockerfile$/i.test(base)) found.push({ name: "Dockerfile", category: "container", evidence: p });
    if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(base)) found.push({ name: "Docker Compose", category: "container", evidence: p });
    if (/^\.dockerignore$/.test(base)) found.push({ name: ".dockerignore", category: "container", evidence: p });
    if (/(^|\/)(k8s|kubernetes|helm)\//.test(p) && /\.ya?ml$/.test(base)) found.push({ name: "Kubernetes", category: "container", evidence: p });
  }
  return uniqueByName(found);
}

export interface EnvFileInfo {
  path: string;
  /** Example/template files (.env.example, .env.sample) are expected to be committed. */
  isTemplate: boolean;
}

export function detectEnvFiles(paths: readonly string[]): EnvFileInfo[] {
  return paths
    .filter((p) => /^\.env(\..+)?$/.test(basename(p)))
    .map((p) => ({ path: p, isTemplate: /\.(example|sample|template|dist|defaults)$/i.test(basename(p)) }));
}

export interface DocsInfo {
  readme: string | null;
  license: string | null;
  contributing: string | null;
  changelog: string | null;
  docsDir: boolean;
}

export function detectDocs(paths: readonly string[]): DocsInfo {
  const top = paths.filter((p) => depth(p) === 0);
  const find = (re: RegExp) => top.find((p) => re.test(p)) ?? null;
  return {
    readme: find(/^readme(\.[a-z]+)?$/i),
    license: find(/^(license|licence|copying)(\.[a-z]+)?$/i),
    contributing: find(/^contributing(\.[a-z]+)?$/i),
    changelog: find(/^(changelog|changes|history)(\.[a-z]+)?$/i),
    docsDir: paths.some((p) => /^docs?\//i.test(p)),
  };
}

// ---------------------------------------------------------------- entry points

const ENTRY_CANDIDATES = /^(src\/)?(index|main|server|app)\.[cm]?[jt]sx?$|^(src\/)?(main|app|wsgi|asgi|manage|__main__)\.py$|^(src\/)?main\.(c|cc|cpp)$/;

export async function detectEntryPoints(reader: ManifestReader): Promise<Detection[]> {
  const found: Detection[] = [];
  const rootPkg = parseJson(await reader.read("package.json"));
  if (rootPkg) {
    if (typeof rootPkg.main === "string") found.push({ name: rootPkg.main, category: "entry", evidence: "package.json: main" });
    const scripts = rootPkg.scripts as Record<string, unknown> | undefined;
    for (const key of ["start", "dev", "serve"]) {
      const cmd = scripts?.[key];
      if (typeof cmd === "string") found.push({ name: cmd, category: "script", evidence: `package.json: scripts.${key}` });
    }
  }
  for (const p of reader.paths) {
    if (ENTRY_CANDIDATES.test(p)) found.push({ name: p, category: "entry", evidence: "conventional entry file name" });
    else if (/(^|\/)(Main|Application)\.java$/.test(p)) found.push({ name: p, category: "entry", evidence: "conventional Java entry class" });
  }
  return uniqueByName(found);
}
