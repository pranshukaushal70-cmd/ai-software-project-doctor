# Architecture

## Principles

1. **Deterministic first.** Anything that can be measured is measured by code, not inferred by an LLM.
2. **Evidence everywhere.** Every detection carries the file/key it came from (`Detection.evidence`), and every
   finding (from Phase 2 on) stores redacted evidence and a stable fingerprint.
3. **Untrusted input.** Repositories are never executed. See [security.md](security.md).
4. **Reproducible.** Each `Analysis` row stores `analyzerVersion` and `commitSha`, and the scoring weights
   (`weightsUsed`) next to the score.
5. **Pure engine.** `packages/analyzer` has no database or HTTP dependencies, so it can be unit-tested and run
   from a CLI for the evaluation benchmark.

## Request flow

```text
POST /api/analysis ──► validate (zod + URL allowlist) ──► Repository + Analysis rows (QUEUED)
        │                                                        │
        └──► 202 { analysisId, status: "queued" }                └──► BullMQ job (jobId = analysisId)

Worker: RUNNING → CLONING → SCANNING → PARSING → SECURITY → DEPENDENCIES → ARCHITECTURE → PRACTICES → INDEXING → COMPLETED | FAILED
UI:     polls GET /api/analysis/:id every 2 s, renders stage progress, then the results
```

Using the analysis id as the BullMQ `jobId` makes enqueueing idempotent. Before starting, the worker deletes the rows a
previous partial attempt may have left (`ArchitectureEdge`, `ArchitectureNode`, `Dependency`, `Finding`, `Metric`,
`File`, and the Phase 6 `SymbolReference`, `CodeSymbol` and `FileDependency`), so a retried job cannot duplicate data. The health score is computed at the end of `PRACTICES`, from every
module's findings. Later stages (`GIT`, `AI`, `REPORT`) exist in the schema but do not run yet; `summary.modulesRun`
lists what actually ran.

## Workspaces

| Package | Depends on | Notes |
|---|---|---|
| `@pd/shared` | zod, pino | `constants` subpath is browser-safe; `logger` is server-only |
| `@pd/analyzer` | shared, yauzl, ignore, web-tree-sitter | ingest (`clone`, `zip`, `workspace`), `scanner`; subpaths `metrics`, `security`, `dependencies`, `architecture`, `practices`, `scoring`, `intelligence` |
| `@pd/db` | shared, Prisma 7 + `@prisma/adapter-pg` | generated client in `src/generated`, committed; regenerate (`npm run db:generate`) and commit it with every `schema.prisma` change. `transitionRun` (Phase 8) is the only way code-engine run statuses change: a compare-and-set checked against the lifecycle in `@pd/shared/engine`, with the approval gates in its `WHERE` clause and an audit event in the same transaction |
| `@pd/worker` | analyzer, db, shared, bullmq | `pipeline.ts` orchestrates stages; `persist.ts` maps analyzer output to rows; supplies `fetch` for OSV.dev; `materialize.ts` rebuilds an analysed source for the code engine (Phase 8) and shares its demo copy and archive extraction with the pipeline; `uploads.ts` deletes archives no analysis refers to any more |
| `@pd/agent` | analyzer, shared, zod, @anthropic-ai/sdk | Engineering planner: context retrieval, LLM providers, plan schema and validation; no database or HTTP code |
| `@pd/web` | agent, analyzer, db, shared, bullmq | route handlers are thin; logic lives in `server/services` |

Packages are consumed as TypeScript source (`exports` → `src/index.ts`), transpiled by Next.js
(`transpilePackages`) and by `tsx` in the worker, so there is no separate build step.

## Repository scanner (Phase 1)

`scanRepository(root)` walks the tree without following symlinks, prunes default-ignored directories
(`node_modules`, `dist`, `.git`, `venv`, `target`, …) and honours the root `.gitignore`. For each file it records
the language (by extension or file name), kind (`SOURCE`, `TEST`, `DOCUMENTATION`, `CONFIG`, `GENERATED`, `BINARY`,
`OTHER`) and physical line count. It then detects:

- package managers and build systems (lockfiles and manifests)
- frameworks and libraries (parsed from `package.json`, `requirements*.txt`, `pyproject.toml` (PEP 621 and Poetry),
  `Pipfile`, `pom.xml`, `build.gradle`)
- CI/CD, containers, `.env` files (distinguishing templates), documentation files, entry points

## Code metrics & static analysis (Phase 2)

`@pd/analyzer/metrics` (a separate subpath so the web bundle never loads the parser) parses JavaScript, TypeScript/TSX,
Python, Java, C and C++ with **tree-sitter compiled to WebAssembly** (`web-tree-sitter` + the grammars' own `.wasm`
builds). Parsing untrusted code therefore never touches native code, and each file has a parse time budget (default 5 s).
`.h` files are parsed as C and fall back to C++ when only the C++ grammar parses them cleanly. Minified files are skipped.

One cursor-based pass per file (no recursion, so deeply nested input cannot overflow the stack) computes:

| Metric | Definition |
|---|---|
| lines / loc / commentLines / blankLines | physical lines; lines with a code token; comment-only lines (Python docstrings count as comments); whitespace-only lines. They always sum to `lines`. |
| lloc | logical lines: statement, declaration and definition nodes |
| functions / classes | function, method and lambda-style function nodes; classes, interfaces, enums, records (C: struct/union definitions) |
| cyclomatic complexity | 1 + decision tokens (`if`, `elif`, loops, `case`, `catch`/`except`, `&&`, `||`, `??`, `and`, `or`, ternaries). Nested functions are measured separately. |
| nesting depth | control-flow constructs inside a function; `else if` chains stay at one level |
| imports / exports | module specifiers and exported names, stored per file; the Phase 4 import graph is built from them. Python `from . import a, b` is recorded as `.a`, `.b` (the bare `.` would point every such import at `__init__.py`) |
| duplication | exact clones (whitespace/comments ignored) of ≥ 50 tokens and ≥ 6 lines across production files, via a verified rolling hash |

Rules (`packages/analyzer/src/metrics/rules.ts`, limits stored in `summary.codeMetrics.thresholds`): high complexity, deep
nesting, long function, long parameter list, large file, god class, empty catch, bare `except:`, `debugger`, TODO/FIXME,
duplicate block, and dead-code indicators that are reliable without whole-program analysis: unreachable statements after
return/throw/break/continue, unused imports (JS/TS/Python/Java; names mentioned in comments, `__all__`, string annotations,
`# noqa` and JSX's implicit `React` are exempt), unused private Java methods, and unreferenced `static` C/C++ functions.

Findings are produced for production source only (test files are measured, not flagged). Each finding stores rule id,
type, severity, file, line range, evidence (redacted of credential-like literals), impact, recommendation, structured
`data`, analyzer id + version, and a fingerprint of (rule, path, stable key such as the function name), so a finding keeps its
identity when code moves. At most 5,000 findings are stored per analysis (most severe first); totals are kept in the summary.

The worker runs this in the `PARSING` stage and stores per-file metrics on `File`, findings on `Finding`, repository
aggregates on `Metric` (`fileId = null`), and `summary.codeMetrics` (totals, per-language stats, hotspots, parser versions).

## Security analysis (Phase 3)

`@pd/analyzer/security` has two parts, both deterministic:

**Secret detection** (`security/secrets.ts`) searches every text file (source, tests, config, docs, `.env`; not binaries,
generated files or oversized files) line by line for:

- well-known credential formats: PEM private keys (only when key material follows the header), AWS access key IDs and
  secret keys, Google API keys, GitHub/GitLab/Slack/Stripe/OpenAI/Anthropic/npm/SendGrid tokens, Slack webhooks, JWTs;
- passwords embedded in connection strings (`postgres://user:<password>@host`), LOW when the host is local;
- values assigned to credential-like names (`password`, `secret`, `token`, `api_key`, `client_secret`, …) in code, JSON,
  YAML, `.properties`, INI/TOML and `.env` files, excluding placeholders (`changeme`, `${VAR}`, `process.env…`,
  `<your-key>`, UPPER_CASE names, labels with spaces, i18n keys, ternaries, and similar);
- committed (non-template) `.env` files that assign values.

Secret values never leave the scanner: evidence shows the line with the value replaced by a mask that keeps at most a
public identifying prefix (e.g. `ghp_…[redacted]`), and fingerprints are derived from the variable name or rule label,
not from the value (a hash of a weak password could be brute-forced). Every secret finding records its file context
(`source`, `configuration`, `template`, `test`, `documentation`; generated files are not scanned). In tests and docs,
arbitrary passwords and connection strings are reported as INFO and marked likely intentional, while real provider
token formats are only one level lower and ask for verification; see [security.md](security.md#secret-findings-context-and-triage).
Templates (`.env.example`) only report real token formats.

**Insecure-pattern detection** (`security/patterns.ts`) inspects the tree-sitter trees of production source through the
`onTree` hook of `analyzeCode`, so each file is parsed once. Rules match the syntactic shape of a dangerous call, with
"dynamic" meaning "not a constant literal":

| Rule | Examples |
|---|---|
| `injection/dynamic-code-execution` (CWE-95) | `eval(x)`, `new Function(x)`, `setTimeout("…" + x)`, Python `eval`/`exec` |
| `injection/os-command` (CWE-78) | `child_process.exec(\`…${x}\`)`, `spawn(…, { shell: true })`, `os.system(x)`, `subprocess.run(…, shell=True)`, `Runtime.exec(x)`, C `system(x)` |
| `injection/sql` (CWE-89) | SQL text built with `+`, template literals, f-strings, `%`, `.format` or `String.format` and passed to `query`/`execute`/`executeQuery`/… (tagged templates such as Prisma's `$queryRaw\`\`` are safe) |
| `injection/xss-sink` (CWE-79) | `innerHTML`/`outerHTML` assignment, `document.write`, `insertAdjacentHTML`, `dangerouslySetInnerHTML` with a dynamic value |
| `unsafe/deserialization` (CWE-502) | `pickle.loads`, `yaml.load` without a safe Loader, `ObjectInputStream`, `XMLDecoder` |
| `crypto/tls-verification-disabled` (CWE-295) | `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `verify=False`, `ssl.CERT_NONE`, `NoopHostnameVerifier`, `CURLOPT_SSL_VERIFYPEER 0` |
| `crypto/jwt-verification-disabled` (CWE-347) | `algorithms: ['none']`, `jwt.decode(…, verify=False)`, `verify_signature: False` |
| `crypto/weak-hash` (CWE-328) | MD5/SHA-1 via `createHash`, `hashlib` (unless `usedforsecurity=False`), `MessageDigest`, OpenSSL |
| `crypto/weak-cipher` (CWE-327) | `createCipher`, DES/RC4/Blowfish, ECB mode, Java `Cipher.getInstance("AES")` |
| `crypto/insecure-randomness` (CWE-338) | `Math.random()`/`random.*`/`java.util.Random` assigned to a token/secret/password/nonce/salt name |
| `memory/unsafe-c-function` (CWE-120) | `gets`, `strcpy`, `strcat`, `sprintf`, `scanf("%s")` |
| `config/debug-mode` (CWE-489) | Flask `app.run(debug=True)`, Django `DEBUG = True` in a settings module |

There is no data-flow analysis, so a flagged call may be safe when its input is trusted; the evidence says what was
matched so a reviewer can judge. Each finding stores `data.cwe` and `data.owasp`. The worker runs this in the `SECURITY`
stage, stores findings (category `SECRET` or `SECURITY`, analyzer `security`) next to the code-quality findings,
`security.*` rows on `Metric`, and `summary.security` (totals, per-rule counts, most affected files, committed env files).
At most 2,000 security findings are stored (most severe first).

## Dependency analysis (Phase 4)

`@pd/analyzer/dependencies` reads manifests and lockfiles as data (nothing is installed or executed):

| Ecosystem | Manifests | Lockfiles (exact versions, transitive packages) |
|---|---|---|
| npm | `package.json` (dependencies, optional, peer, dev) | `package-lock.json` / `npm-shrinkwrap.json` v1–3, `yarn.lock` (classic and Berry), `pnpm-lock.yaml` v5–9, `bun.lock`; `bun.lockb` is binary: recognised (no "missing lockfile") but not read |
| PyPI | `requirements*.txt`, `pyproject.toml` (PEP 621, PEP 735 groups, Poetry, uv), `Pipfile` | `poetry.lock`, `uv.lock`, `pdm.lock`, `Pipfile.lock` |
| Maven | `pom.xml` (`${properties}`, `dependencyManagement`; parent POMs are not fetched), `build.gradle(.kts)` string notation | none (exact versions come from the manifest) |
| Go | `go.mod` (`// indirect` = transitive; local `replace` = path dependency) | none (`go.mod` versions are exact) |
| Cargo | `Cargo.toml` (incl. `[dependencies.x]` tables, renames, target-specific tables) | `Cargo.lock` |

Each manifest is paired with the nearest lockfile in its directory or a parent (monorepos and workspaces), and
workspace-internal packages are recognised and excluded from registry checks. Every dependency records whether it is
**direct** (declared in a manifest) or **transitive** (only in a lockfile), dev-only, its declared spec and resolved
version, the manifest or lockfile it comes from, and its source (`registry`, `git`, `url`, `path`, `workspace`). The
analyzer does not reconstruct which package requires which; the relationship stored is direct vs transitive and where it
is declared or locked.

**Vulnerabilities.** Exact registry versions are looked up on OSV.dev ([security.md](security.md#outbound-network-osvdev)
explains what is sent and how private packages are handled). Severity comes from the CVSS v3 base score computed from the
advisory's vector, else from the advisory database's own rating, else MEDIUM; dev-only packages are rated one level
lower. The suggested fix is the lowest version that fixes every advisory affecting the installed version (none when an
advisory has no fix).

| Rule | Severity |
|---|---|
| `dependency/known-vulnerability` | from the advisories (see above) |
| `dependency/missing-lockfile` | MEDIUM with runtime dependencies, LOW for dev-only or a `Pipfile` |
| `dependency/unpinned-version` (`*`, `latest`, empty, Maven `LATEST`/`1.+`) | LOW, INFO for dev |
| `dependency/non-registry-source` (git or URL) | LOW |
| `dependency/unused-candidate` (npm runtime dependency that no JS/TS file of the package imports and that package scripts and config files do not mention) | INFO |

The worker runs this in the `DEPENDENCIES` stage and stores one `Dependency` row per package (with `vulnIds` and
`dataSource`), `DEPENDENCY` findings, `dependencies.*` metrics and `summary.dependencies` (totals, per-ecosystem counts,
manifests, lookup status, and the 100 most severe vulnerable packages with advisory details). `Dependency` has no
columns for the declaration line or source, so the line is only kept where a finding refers to the dependency.

## Architecture analysis (Phase 4)

`@pd/analyzer/architecture` builds the import graph of production source files (tests, generated code and assets are
not nodes) from the imports recorded by the code-metrics pass. Resolution is static and conservative, linking an import
only when the language's lookup rules point at exactly one file:

- **JavaScript/TypeScript:** relative paths with extension and `index` lookup, `.js` specifiers that refer to `.ts`
  sources, `tsconfig`/`jsconfig` `paths` and `baseUrl` (following relative `extends`), and workspace packages through
  `package.json` `exports`/`main`. Node built-ins and third-party packages are counted separately.
- **Python:** relative imports and absolute imports from detected package roots (`src/` and the parents of top-level
  packages); standard-library modules are recognised.
- **Java:** class, nested-class, static and wildcard imports by package path.
- **C/C++:** `#include` next to the file, from the root, from `include`/`inc`/`src` directories, or by a unique path suffix.

On the file graph it finds **import cycles** (Tarjan's strongly connected components; each is reported with its shortest
loop), computes fan-in/fan-out, and groups files into **modules** by directory, choosing the deepest level (≤ 8) that
gives at most 30 modules. Each module gets fan-in, fan-out and instability = fan-out ÷ (fan-in + fan-out). **Layers**
(interface → service → data → shared) are inferred from directory and file names and checked only when at least two are
present.

| Rule | Severity |
|---|---|
| `architecture/circular-dependency` | MEDIUM when JavaScript, TypeScript or Python is involved (cycles cause partially initialised modules at runtime), LOW for compiled languages; one level higher at ≥ 10 files |
| `architecture/layer-violation` (a lower layer imports a higher one) | LOW |
| `architecture/high-fan-out` (> 20 internal files imported; barrel files such as `index.ts` exempt) | LOW, MEDIUM above 40 |

The worker runs this in the `ARCHITECTURE` stage and stores `ArchitectureNode` rows (`FILE` and `MODULE`, at most
10,000 file nodes, the most connected first) with their metrics, `ArchitectureEdge` rows (`import` between files,
`module` between modules, with weight and `inCycle`), `ARCHITECTURE` findings, `architecture.*` metrics and
`summary.architecture` (totals, modules, module edges, cycles, hubs, layers, top external packages, resolution info).

## API, database, testing and documentation analysis (Phase 5)

`@pd/analyzer/practices` reads every source, test, documentation and configuration file (plus `.sql` and `.prisma`
files) once and runs four deterministic analyzers over the text. Nothing is executed or connected to. Findings use the
existing `API`, `DATABASE`, `TESTING` and `DOCUMENTATION` categories, analyzer `practices`, and the same fingerprint
scheme (rule, path, stable key) as the other modules, so triage follows them across re-analyses. Repository-level
findings (no README, no tests) have an empty path and no file. At most 2,000 are stored, most severe first; thresholds
are stored in `summary.practices.thresholds`.

**API.** Endpoints are found from their declaration syntax: Express-style `app.get("/path")` / `router.post(…)` calls
(only in files importing a server framework, or on objects named like a server or router, so HTTP-client calls such as
`axios.get("/x")` are not routes), `.route("/x").get().post()` chains, NestJS decorators with the controller prefix,
Next.js route handlers (`app/**/route.ts` exports, route groups removed) and `pages/api`, Flask/FastAPI decorators,
Django `urls.py` and DRF routers, and Spring `@…Mapping` annotations with the class-level prefix. Each endpoint records
whether an authentication marker (middleware, guard, decorator or user check) is visible in the route, its file or the
application set-up (Next.js middleware, Spring Security, global guards, `app.use(auth)`), and whether the body is read
and validated. The API rules report what was not seen; authentication applied where the analysis cannot look (an API
gateway, a wrapper in another package) is not recognised.

| Rule | Severity |
|---|---|
| `api/permissive-cors` (CWE-942): `cors()`, `origin: "*"`/`true`, reflected `Access-Control-Allow-Origin`, Flask-CORS/FastAPI/django-cors-headers allow-all, Spring `@CrossOrigin`/`allowedOriginPatterns("*")` | HIGH when any origin is reflected with credentials, else LOW |
| `api/error-details-exposed` (CWE-209): stack traces in responses | MEDIUM |
| `api/unauthenticated-mutation` (CWE-306): POST/PUT/PATCH/DELETE without a visible auth check; public paths (login, webhooks, health …) exempt | LOW (heuristic) |
| `api/missing-input-validation` (CWE-20): body read with no schema validation visible | LOW |
| `api/auth-without-rate-limit` (CWE-307): a login endpoint, and no rate-limiting library or configuration anywhere | LOW |
| `api/no-specification`: ≥ 5 endpoints, no OpenAPI/Swagger file, no generator (FastAPI counts) and no `docs/api*.md` | LOW |

**Database.** Prisma schemas are parsed per model (fields, `@id`/`@unique`, `@@index`/`@@unique`/`@@id`,
`@relation(fields:)`). SQL files (schemas and migrations, comments stripped) are parsed for `CREATE TABLE` bodies, inline
and table-level keys, `CREATE INDEX` and `ALTER TABLE … FOREIGN KEY`. SQLAlchemy, Django, TypeORM, Sequelize, Mongoose and
JPA models are counted from their declarations. Migration tools are recognised by path (Prisma Migrate, Django, Alembic,
Flyway, Liquibase, Rails, JavaScript and SQL migration directories).

| Rule | Severity |
|---|---|
| `database/unindexed-foreign-key`: no index, primary key or unique constraint starts with the foreign-key columns (Prisma, SQL, SQLAlchemy without `index=True`). Skipped for MySQL, which indexes foreign keys itself, and for SQL generated from a Prisma schema | LOW |
| `database/table-without-primary-key` (non-temporary SQL tables) | MEDIUM |
| `database/auto-schema-sync`: TypeORM `synchronize: true`, Sequelize `sync({ force/alter })`, Hibernate `ddl-auto`/`hbm2ddl.auto` = update/create/create-drop (test configuration exempt) | MEDIUM |
| `database/no-migrations`: models declared and no migration files at all | LOW |

**Testing.** Test files come from the scanner's classification. Test cases are counted per language (`it`/`test`
including `.each`/`xit`/`fit`, `def test_`, `@Test`, gtest `TEST`, Go `func Test`). The test-to-code ratio uses code lines
from the metrics pass (physical lines for languages without a parser). A production file counts as referenced when a test
imports a module of the same name or is named after it; this is a proxy, not coverage. Coverage is read only from
committed reports (lcov, Istanbul `coverage-summary.json`, coverage.py JSON, Cobertura, JaCoCo), including `coverage/`,
which the scanner skips: there, the directory and the file must be real (not symlinks) and at most 20 MB. CI files are
searched for a test command.

| Rule | Severity |
|---|---|
| `testing/no-tests` (≥ 200 production code lines) | MEDIUM, HIGH from 2,000 lines |
| `testing/low-test-ratio` (< 0.2) | LOW, MEDIUM below 0.05 |
| `testing/low-coverage` (committed report below 70 %) | LOW, MEDIUM below 50 % |
| `testing/focused-test` (`.only`, `fit`) | LOW |
| `testing/skipped-test` (`.skip`, `xit`, `@pytest.mark.skip`, `@Disabled`, `@Ignore`) | INFO |
| `testing/tests-not-in-ci` (no CI, or CI without a test command) | LOW |
| `testing/no-test-script` (JS/TS repository whose `scripts.test` is missing or npm's placeholder) | LOW |
| `testing/untested-file` (≥ 150 code lines, referenced by no test; the 20 largest) | INFO |

**Documentation.** The README is checked for length (≥ 150 words) and for installation and usage instructions (headings,
or the commands they would contain such as `npm install` or `npm start`). Environment variables read by production code
(`process.env`, `import.meta.env`, `os.environ`/`getenv`, `System.getenv`, C `getenv`; runtime variables such as
`NODE_ENV` excluded) must appear in a committed `.env` template, a documentation file or configuration. Only names are
recorded, never values. Relative Markdown links outside code blocks must point at a file or directory of the repository.

| Rule | Severity |
|---|---|
| `documentation/missing-readme` | MEDIUM |
| `documentation/incomplete-readme` | LOW |
| `documentation/missing-license` (a manifest `license` field is mentioned but does not replace the license text) | LOW |
| `documentation/undocumented-env-vars` | LOW |
| `documentation/broken-link` (at most 50) | LOW |

The worker runs this in the `PRACTICES` stage and stores the findings, `api.*`, `database.*`, `testing.*` and
`documentation.*` metrics, and `summary.practices`. The **Practices** tab shows the four areas and their findings.

## Health score (Phase 5)

`@pd/analyzer/scoring` (`computeHealthScore`, scoring version 1.0) turns the findings into a 0–100 score that can be
explained line by line:

| Dimension | Weight | Finding categories |
|---|---|---|
| Security | 25 | `SECRET`, `SECURITY` |
| Code quality | 15 | `CODE_QUALITY` (per 1,000 production code lines) |
| Dependencies | 15 | `DEPENDENCY` |
| Testing | 15 | `TESTING` |
| Architecture | 10 | `ARCHITECTURE` (per 1,000 production code lines) |
| Documentation | 10 | `DOCUMENTATION` |
| API | 5 | `API` |
| Database | 5 | `DATABASE` |

1. Each dimension starts at 100. Findings cost CRITICAL 30, HIGH 15, MEDIUM 6, LOW 2 and INFO 0 points, capped per
   severity at 60/45/30/15. Code-quality and architecture findings grow with code size, so they count per 1,000
   production code lines. `testing/no-tests` (80) and `documentation/missing-readme` (40) have fixed penalties instead.
   Duplicated code above 5 % costs 1 point per percent, at most 15. Every deduction is stored as a factor with how it was
   computed.
2. Dimensions with nothing to measure (no endpoints, no database, no manifests, no source code) and no findings are left
   out, and the remaining weights are rescaled.
3. The overall score is the rounded weighted mean. While critical (or high) `SECRET`/`SECURITY` findings are open it is
   capped at 49 (or 69): a weighted mean would otherwise let good tests and documentation hide an exploitable problem.
   Both the weighted score and the cap are stored.
4. Findings the user triaged as Expected or Ignored for the repository (matched by fingerprint) do not count; they are
   still reported. The score is stored with the analysis, so triage changes take effect in the next analysis.
5. Grades: A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 40, F below. Caveats record what the score could not consider: a disabled, failed
   or partial vulnerability lookup, a missing coverage report, triaged findings.

The worker stores the score in `Analysis.healthScore`, the breakdown in `scoreBreakdown`, the parameters (weights,
penalties, caps, grades) in `weightsUsed`, and `score.*` metrics. The **Health** tab shows every dimension and deduction,
the Overview the score and the weakest dimensions, and the dashboard the latest score of each repository.

## Demo project (Phase 5)

`demo/storefront` is a small, deliberately flawed Express + Prisma shop; [demo/README.md](../demo/README.md) lists the
planted issues. `POST /api/analysis/demo` creates one `DEMO` repository per user (so re-runs and triage stay together) and
queues an analysis. The worker copies the project into the analysis workspace (`PipelineDeps.demoDir`, by default
`demo/storefront` in this repository) and renames `package.json.demo` and `package-lock.json.demo` back. The manifests
carry that suffix so that dependency scanners (GitHub's dependency graph, Dependabot) do not report the demo's
intentionally outdated packages against this repository.

## Repository intelligence (Phase 6)

`@pd/analyzer/intelligence` builds a queryable representation of the repository for later AI agents; the full design,
including what is exact and what is approximate, is in [repository-intelligence.md](repository-intelligence.md).

- **Symbols** (functions, classes, methods, interfaces, types, enums, constants), **import bindings** and **call sites**
  are extracted from the syntax trees the metrics pass already parses (`onTree` hook; TypeScript, JavaScript, Python).
- In the `INDEXING` stage every import of a source or test file is resolved with the architecture resolver into
  `FileDependency` rows (`INTERNAL`, `EXTERNAL`, `BUILTIN`, `UNRESOLVED`); calls are linked to the called symbol when
  imports make that unambiguous (`SymbolReference.targetSymbolId`), else kept by name when the name is defined in the
  repository; calls of library code are not stored.
- A **manifest** (languages, frameworks, runtimes, manifests, lockfiles, Docker, CI, infrastructure, directories, file
  roles) and module, ranking (PageRank), cycle and package statistics go into `summary.intelligence`.
- The scanner stores a SHA-256 `contentHash` per readable file.
- `RepositoryGraph` answers importers/imports, callers, related tests, BFS traversals, impact analysis and keyword search
  deterministically; the web tier caches it per completed analysis.

The **Intelligence** tab shows the manifest, index totals, symbol search with callers, impact analysis (drawn with the
architecture graph component), modules, most depended-upon files, external packages, unresolved imports and the tree.

## Engineering planner (Phase 7)

`@pd/agent` turns a developer task into a validated, evidence-cited engineering plan on top of the Phase 6 index; the
full design is in [engineering-agent.md](engineering-agent.md).

- **Context retrieval** is deterministic: `RepositoryGraph.search`, `imports` and `impact` (dependants, related tests,
  related configuration), the stored manifest and routes, external package imports and existing findings become a
  bounded, numbered evidence bundle. No file contents.
- **Providers** implement `LLMProvider.generatePlan`: Anthropic (structured JSON output, default `claude-opus-5-5`), a
  deterministic baseline without an LLM, and a scripted provider for tests.
- **Validation** parses the output with the plan schema and checks every file, symbol, test and evidence reference
  against the index; it flags hallucinations, downgrades unsupported VERIFIED claims, redacts secrets, removes shell
  commands and adjusts confidence.
- `engineering-service.ts` in the web tier owns persistence and authorization; planning runs after the `202` response
  via `after()`. The **Planner** page lists tasks per analysis and renders plans with their evidence.

## Web API and UI (Phase 4)

`GET /api/analysis/:id/dependencies` and `GET /api/analysis/:id/architecture` ([api.md](api.md)) follow the findings
route: authenticated, ownership-checked through `getOwnedAnalysis`, zod-validated queries
(`dependenciesQuerySchema`/`architectureQuerySchema` in `@pd/shared`), with the query logic in
`web/server/services/{dependency,architecture}-service.ts`.

The analysis page has **Dependencies** and **Architecture** tabs:

- *Dependencies*: lookup status (explains partial, failed, disabled and skipped lookups instead of showing zero
  vulnerabilities), headline counts, vulnerable packages with relationship, fixed version and advisory links,
  ecosystems, manifests and lockfiles, a filterable and paginated table of every dependency (direct/transitive, dev,
  ecosystem, vulnerable only, name search), and dependency findings.
- *Architecture*: headline counts, import cycles shown as paths, an SVG import graph (module view, or file view filtered
  by module or to cycle members; layered left to right by longest import chain, cycle edges highlighted, at most 60
  modules or 80 files with a note when truncated), a module table with instability, most imported and most importing
  files, layers, top external packages, and architecture findings.

Analyses made by earlier analyzer versions show a notice in these tabs instead of empty results.

## Data model

See `packages/db/prisma/schema.prisma`. Results hang off `Analysis` and cascade on delete:
`File`, `Finding`, `Metric`, `Dependency`, `ArchitectureNode`/`ArchitectureEdge`, `GitInsight`, `Recommendation`,
`Report`. Phase 1 populates `Analysis.summary` and `File`; Phase 2 adds file metrics, `Finding` and `Metric`; Phase 3 adds
`SECRET`/`SECURITY` findings and `summary.security`; Phase 4 fills `Dependency`, `ArchitectureNode` and `ArchitectureEdge`
and adds `DEPENDENCY`/`ARCHITECTURE` findings and `summary.dependencies`/`summary.architecture`. Phases 3 and 4 needed no
schema change: the tables, categories and stages already existed. Phase 5 adds `API`/`DATABASE`/`TESTING`/`DOCUMENTATION`
findings and `summary.practices`, and fills `healthScore`, `scoreBreakdown` and `weightsUsed`; its only schema change is
the `PRACTICES` value of `AnalysisStage` (migration `20261003120000_practices_stage`). Phase 6 adds `CodeSymbol`,
`SymbolReference`, `FileDependency`, `File.contentHash`, the `SymbolKind` and `DependencyKind` enums and the `INDEXING`
stage (migration `20261004120000_repository_intelligence`), and `summary.intelligence`. `FindingTriage` (migration `20261002120000_finding_triage`)
stores Expected/Ignored decisions per repository and finding fingerprint; it is the only table that outlives an
analysis's findings, and it is deleted with its repository. Phase 7 adds `EngineeringTask`, `EngineeringPlan` and
`EngineeringPlanEvidence` and the `EngineeringPlanStatus` enum (migration `20261005120000_engineering_planner`); tasks
cascade from both the user and the analysis. Later phases fill the rest.
