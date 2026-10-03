# AI Software Project Doctor

> Diagnose your software before it breaks.

An engineering-analysis platform that takes a GitHub/GitLab repository URL or a ZIP upload and produces an
evidence-based health report. Deterministic analysis (parsing, metrics, secret detection, dependency and
architecture graphs) comes first; an LLM is used only afterwards, over structured and redacted findings, to
explain, prioritise and recommend, and it must cite the evidence it uses.

**Status: Phase 1 (foundation) complete. Phases 2 (code metrics & static analysis), 3 (secret & insecure-pattern
detection), 4 (dependency & architecture analysis) and 5 (API, database, testing and documentation analysis, an
explainable health score and a demo project), 6 (repository intelligence: manifest, symbol index, dependency graph,
impact analysis and an agent context API) and 7 (an AI engineering planner that turns a task into an evidence-backed,
validated plan) are implemented and tested.** See [Roadmap](#roadmap) and
[Verification status](#verification-status). Nothing described as "planned" below is implemented yet.

## Problem statement

Students and small teams rarely get a senior engineer's review of a whole project. Generic "paste your code
into a chatbot" reviews are unreliable: the model sees an arbitrary slice of code, cannot measure anything,
and invents issues. This project asks:

> How can deterministic software-engineering analysis be combined with LLM-based reasoning to provide
> explainable, repository-level software health assessment?

## Architecture

```text
Browser ─► Next.js (UI + /api) ─► PostgreSQL
               │ enqueue                ▲
               ▼                        │ results
             Redis ◄── BullMQ ──► Worker ┘
                                   │
          ingest (hardened clone / safe ZIP) → scan → code metrics → security → dependencies (+ OSV.dev)
          → architecture → API / database / tests / docs → health score → repository index
          → [git → redaction → AI reasoning → report]   (bracketed: planned)
```

| Path | Purpose |
|---|---|
| `apps/web` | Next.js 16 app: landing page, auth, dashboard, API route handlers |
| `apps/worker` | BullMQ worker that runs the analysis pipeline |
| `packages/analyzer` | Pure deterministic engine: no database; network only for `git clone` and the OSV.dev lookup, which uses a `fetch` passed in by the worker |
| `packages/db` | Prisma 7 schema, migrations and client |
| `packages/shared` | Types, zod schemas, errors, URL validation, logger |

More detail: [docs/architecture.md](docs/architecture.md), [docs/security.md](docs/security.md), [docs/api.md](docs/api.md).

## What it analyses today

Each completed analysis has one tab per module:

| Tab | Module | What you get |
|---|---|---|
| Overview | Repository scan | Languages, tooling, frameworks, CI, docs, `.env` files, file tree |
| Code quality | Code metrics (Phase 2) | LOC, complexity, nesting, duplication, hotspots, code-smell findings |
| Security | Secrets & insecure patterns (Phase 3) | Masked secret findings, CWE/OWASP-mapped insecure calls |
| Dependencies | Dependency analysis (Phase 4) | npm, PyPI, Maven/Gradle, Go and Cargo manifests and lockfiles; direct vs transitive packages; known vulnerabilities from OSV.dev with fixed versions; missing lockfiles, unpinned, git/URL and unused dependencies |
| Architecture | Import graph (Phase 4) | File and module import graph (SVG), import cycles, module coupling and instability, inferred layers and violations, hubs, high fan-out |
| Practices | API, database, testing & documentation (Phase 5) | HTTP endpoints (Express, Fastify, Koa, Hono, NestJS, Next.js, Flask, FastAPI, Django, Spring) with auth/validation checks, permissive CORS, leaked stack traces, unthrottled login; Prisma/SQL/ORM schemas with unindexed foreign keys, missing primary keys, missing migrations and automatic schema sync; test files, test cases, test-to-code ratio, committed coverage reports, CI test runs, focused/skipped tests; README completeness, license, undocumented environment variables, broken links |
| Health | Explainable health score (Phase 5) | 0–100 score and grade from eight weighted dimensions, with every deduction listed; triaged findings excluded; capped while critical/high security findings are open |
| Planner | AI engineering planner (Phase 7) | Planner page: describe a task, get a plan (affected files and symbols, steps, test plan, configuration and dependency changes, security, performance, risks, validation plan) generated from repository-index evidence; every claim marked VERIFIED, INFERRED or UNKNOWN with cited evidence; nonexistent files and symbols flagged, secrets and shell commands removed. Planning only, nothing executed. See [docs/engineering-agent.md](docs/engineering-agent.md) |
| Intelligence | Repository intelligence (Phase 6) | Repository manifest (languages, frameworks, runtimes, manifests, Docker, CI, infrastructure), symbol search with callers, resolved file dependencies, deterministic impact analysis (dependants, tests, routes, config, modules), most depended-upon files, external packages, unresolved imports, file tree. See [docs/repository-intelligence.md](docs/repository-intelligence.md) |
| All findings | — | Every finding with evidence, impact and recommendation, filterable by severity and type |

The same data is available from the API, including `GET /api/analysis/:id/dependencies` and
`GET /api/analysis/:id/architecture` ([docs/api.md](docs/api.md)).

**Demo project.** Signed-in users can analyse a bundled, deliberately flawed sample application from **New analysis →
Try the demo project** (`POST /api/analysis/demo`). Its planted issues are listed in [demo/README.md](demo/README.md).

## Tech stack

Next.js 16 · React 19 · TypeScript 6 · Tailwind CSS 4 · PostgreSQL 17 · Prisma 7 · Redis 7 · BullMQ 6 ·
argon2id (`@node-rs/argon2`) · zod 4 · pino · Vitest 5.

## Prerequisites

- **Node.js 24 LTS** (`.nvmrc` pins it)
- **Docker Desktop** (for PostgreSQL and Redis)
- **Git** (the worker clones repositories)

## Getting started

```bash
npm install                 # also generates the Prisma client
node scripts/setup-env.mjs  # creates .env with a random JWT_SECRET and database password
npm run services:up         # starts postgres + redis via docker compose
npm run db:deploy           # applies migrations
npm run dev                 # web app on http://localhost:3000
npm run worker              # in a second terminal: the analysis worker
```

## Environment variables

See [.env.example](.env.example). The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (its credentials must match `POSTGRES_*`) |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Used by `docker-compose.yml` to create the database. `POSTGRES_PASSWORD` is required (no default); it only takes effect when the database volume is first created. PostgreSQL and Redis are published on `127.0.0.1` only |
| `REDIS_URL` | Redis for the job queue and rate limiting |
| `JWT_SECRET` | ≥32-char secret used to HMAC session tokens before storage |
| `AI_PROVIDER` | Engineering planner provider: `anthropic` (default; needs `ANTHROPIC_API_KEY`) or `baseline` (deterministic evidence-only plans, no LLM) |
| `ANTHROPIC_API_KEY` | Optional. Enables LLM planning (Phase 7). Read from the environment only; never stored, logged or sent to the browser |
| `ANTHROPIC_MODEL` | Planner model, default `claude-opus-5-5` |
| `WORKSPACE_DIR` | Where uploads and clones are stored temporarily (default: OS temp dir) |
| `MAX_UPLOAD_MB`, `MAX_EXTRACTED_MB`, `MAX_ZIP_ENTRIES`, `MAX_COMPRESSION_RATIO`, `MAX_FILE_KB` | Ingest safety limits |
| `CLONE_TIMEOUT_SECONDS`, `CLONE_DEPTH` | Clone limits |
| `OSV_ENABLED` | `true` (default) checks exact dependency versions against OSV.dev; `false` makes no OSV.dev requests. See [security.md](docs/security.md#outbound-network-osvdev) for what is sent |
| `OSV_TIMEOUT_SECONDS` | Time budget for the whole OSV.dev lookup of one analysis (default 90) |

## Scripts

| Command | What it does |
|---|---|
| `npm test` | All unit tests (Vitest, all workspaces) |
| `npm run typecheck` | `tsc` across all workspaces |
| `npm run build` | Production build of the web app |
| `npm run db:migrate` | Create a new migration during development |

## Security considerations

Repositories are untrusted input. Code is **never executed**: no installs, builds or scripts. Clones run with
hooks, submodules, LFS and non-https transports disabled; ZIPs are checked for traversal, symlinks,
bombs and size limits before anything is written. Manifests and lockfiles are parsed as data, never installed.

The dependency check sends **package names and exact versions** (nothing else) to the public OSV.dev API. npm and
Cargo packages from a private registry are withheld: the registry is read from the lockfile (`package-lock.json`,
classic `yarn.lock`, pnpm tarball URLs, `bun.lock`, `Cargo.lock`) or, where the lockfile does not record it, from the
repository's `.npmrc` / `.yarnrc.yml`. PyPI, Maven and Go do not record the registry, and npm registries configured
outside the repository cannot be seen, so set `OSV_ENABLED=false` when analysing such code. Details and threat model:
[docs/security.md](docs/security.md).

The engineering planner sends the task and a bounded set of index facts (paths, symbol and route names, one-line
summaries, finding titles) to the configured LLM provider: never file contents, finding evidence or `.env` values. Its
output is treated as untrusted: it is schema-checked, every file and symbol is checked against the index, and secrets and
shell commands are removed before storage. Nothing it produces is executed. With `AI_PROVIDER=baseline` no external
request is made. See [docs/engineering-agent.md](docs/engineering-agent.md#security-boundaries).

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Workspace, schema, auth, hardened ingest, repository scanner, job queue, base UI | ✅ Done |
| 2 | Tree-sitter adapters (JS/TS/Python/Java/C/C++), LOC, complexity, smells | Implemented; E2E pending |
| 3 | Secret detection, insecure-pattern rules, security dashboard | Implemented; E2E pending |
| 4 | Dependencies + OSV.dev, import graph, cycles, architecture view (API + Dependencies/Architecture tabs) | Implemented and unit-tested; E2E pending |
| 5 | API/DB/test/docs analyzers, explainable health score, demo project (Practices and Health tabs) | Implemented and tested |
| 6 | Repository intelligence layer: manifest, symbol index, dependency graph, impact analysis, agent context API (Intelligence tab) | Implemented and tested |
| — | Git history insights (previously planned as Phase 6) | Planned |
| 7 | AI engineering planner: provider layer (Anthropic default, deterministic baseline), evidence retrieval from the index, validated evidence-cited plans, Planner page | Implemented and tested |
| — | Evidence-cited recommendations and fix suggestions on findings | Planned |
| 8 | Reports (PDF/JSON/Markdown/HTML) | Planned |
| 9 | Dockerised web/worker, CI, E2E tests, benchmark & evaluation | Planned |

## Verification status

`npm test` (Vitest, all workspaces): **544 tests in 30 files, all passing**; `npm run typecheck` is clean for all five
workspaces and `npm run build` succeeds.

| Area | Tests |
|---|---|
| Analyzer: repository intelligence (TS/JS/Python symbol extraction incl. CommonJS, default exports and `__all__`, malformed files, file roles, manifest and runtimes, untrusted version strings, secret files never read, ingestion of ignored/gitignored/binary/oversized/symlinked files, content hashing, imports escaping the root, internal/external/builtin/unresolved resolution, call resolution, cycles, PageRank, modules, importers/callers, file/symbol/module impact, depth limits, name-matched tests, unknown targets, keyword search) | 20 |
| Analyzer: practices (API endpoints for every supported framework, auth/validation/CORS/stack-trace/rate-limit rules, Prisma/SQL/SQLAlchemy schemas, auto schema sync, test counting, coverage reports incl. `coverage/`, CI, README/license/env vars/links, fingerprints) | 24 |
| Analyzer: scoring (penalties and caps, per-1,000-line dimensions, fixed penalties, duplication, applicability, security cap, triage exclusion, caveats, grades, weights) | 13 |
| Analyzer: dependencies, architecture, metrics, security, scanner, ZIP, clone | 53, 32, 31, 155, 18, 23, 7 |
| Worker: pipeline (fake Prisma and OSV.dev: ZIP upload, stages incl. `PRACTICES` and `INDEXING`, persisted score and repository index, OSV outage/disabled, demo project end to end, missing demo, triaged findings excluded from the score, retry clean-up) and row mapping (incl. index rows) | 10 + 17 |
| Web API: repository intelligence (manifest, modules, symbols, references, imports, impact, agent context; validation incl. path traversal, Origin check, 401/404 on every endpoint, unindexed analyses, graph cache) | 13 |
| Web API: analysis modules, triage, demo endpoint (auth, Origin check, rate limit, one demo repository per user, `scoreBreakdown` owner-only), services, HTTP helpers, session tokens | 13 + 7 + 4 + 20 + 7 + 7 |
| Web UI (server-rendered markup): Intelligence panel and impact view | 6 |
| Web UI (server-rendered markup): tabs incl. Practices, Health and Intelligence, Health and Practices panels, security, dependencies and architecture panels, graph layout | 10 + 7 + 8 + 8 + 6 + 6 |
| Shared: URL validation, schemas | 15 + 4 |

**End to end (Phase 6, on 2026-10-03)** against PostgreSQL 17 and Redis 7 with the production build and the worker: the
`20261004120000_repository_intelligence` migration applied with no schema drift; this repository (328 files) indexed to
1,115 symbols and 2,449 call references (1,805 resolved, including across workspace packages) with correct answers for
definitions, callers, importers and impact; a generated 2,701-file repository indexed to exactly the expected 17,500 symbols
and 7,700 internal imports (index built in 0.3 s; impact query 1.4 s cold, 0.16 s cached); the Intelligence tab worked in
headless Chromium (search, callers, impact graph, dark mode, 390 px); and the Phase 5 and earlier end-to-end checks passed
unchanged.

**End to end (Phase 5, on 2026-10-03)** against PostgreSQL 17 and Redis 7 in Docker with the production build and the
worker: the `20261003120000_practices_stage` migration applied with no schema drift (`prisma migrate diff`); the demo
project analysed through `POST /api/analysis/demo` passed every stage including `PRACTICES` and found the planted issues in
every category (with a live OSV.dev lookup); the score, breakdown and weights were persisted and served; triaging the open
high security findings excluded them from the next run's score; a ZIP upload, every analysis endpoint and cross-user
isolation (404) still worked; and the Overview, Practices and Health tabs, the dashboard score and the demo entry points
rendered in headless Chromium without console errors, in dark mode and at 390 px width without horizontal scrolling.
