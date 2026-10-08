# AI Software Project Doctor

> Diagnose your software before it breaks.

An engineering-analysis platform that takes a GitHub/GitLab repository URL or a ZIP upload and produces an
evidence-based health report, then helps fix what it found. Deterministic analysis (parsing, metrics, secret detection,
dependency and architecture graphs, a repository index) comes first; an LLM is used only afterwards, over that index, to
plan an engineering task with cited evidence and, after the user approves the plan, to write the change. The user approves
again before the repository's tests run in an isolated sandbox, and the result is a patch and a report, never a commit.

**Status: Phases 1 (foundation), 2 (code metrics & static analysis), 3 (secret & insecure-pattern
detection), 4 (dependency & architecture analysis) and 5 (API, database, testing and documentation analysis, an
explainable health score and a demo project), 6 (repository intelligence: manifest, symbol index, dependency graph,
impact analysis and an agent context API), 7 (an AI engineering planner that turns a task into an evidence-backed,
validated plan), 8 (a code engine that turns an approved plan into a validated change, runs the repository's tests in
an isolated sandbox after a second approval, and hands over a patch) and 9 (reports: immutable, redacted snapshots of
what was found, planned, changed, validated and tested) and 10 (production images, CI, end-to-end tests and benchmarks)
are implemented and tested.** See [Roadmap](#roadmap) and
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

Planner / code engine (Phase 7–8), engineering queue in the same worker:
  task → plan (index evidence, validated) → plan approval → rebuild analysed source → edits (validated, re-checked)
       → test-command approval → disposable Docker sandbox (repair within budget) → patch for review (no commit/push)

Reports (Phase 9), on demand: immutable, redacted snapshots of an analysis, a plan or a run, built from stored data.
```

| Path | Purpose |
|---|---|
| `apps/web` | Next.js 16 app: landing page, auth, dashboard, API route handlers |
| `apps/worker` | BullMQ worker: the analysis pipeline, and planner and code-engine jobs |
| `packages/analyzer` | Pure deterministic engine: no database; network only for `git clone` and the OSV.dev lookup, which uses a `fetch` passed in by the worker |
| `packages/db` | Prisma 7 schema, migrations and client |
| `packages/shared` | Types, zod schemas, errors, URL validation, logger, code-engine run lifecycle |
| `packages/agent` | Engineering planner and code-engine editing: context, providers, schemas, validation, diffs |
| `packages/engine` | Planner and code-engine jobs, run controls, source rebuilding |
| `packages/sandbox` | Disposable Docker sandbox for approved test runs |
| `packages/reports` | Report snapshots: collection, deterministic building, redaction, storage, Markdown export |

More detail: [docs/architecture.md](docs/architecture.md), [docs/security.md](docs/security.md), [docs/api.md](docs/api.md),
[docs/code-engine.md](docs/code-engine.md), [docs/reports.md](docs/reports.md), [docs/deployment.md](docs/deployment.md),
[docs/testing.md](docs/testing.md), [docs/benchmark.md](docs/benchmark.md), [docs/demo.md](docs/demo.md).

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
| Planner | AI engineering planner (Phase 7) | Planner page: describe a task, get a plan (affected files and symbols, steps, test plan, configuration and dependency changes, security, performance, risks, validation plan) generated from repository-index evidence; every claim marked VERIFIED, INFERRED or UNKNOWN with cited evidence; nonexistent files and symbols flagged, secrets and shell commands removed. See [docs/engineering-agent.md](docs/engineering-agent.md). **Code engine (Phase 8):** approve a plan, and the engine proposes the change in an isolated copy of the analysed source: per-file diffs with validation flags; with a second approval it runs the repository's tests in a disposable sandbox and repairs failures within a budget; download the patch or discard it. Nothing is committed or pushed. See [docs/code-engine.md](docs/code-engine.md) |
| Intelligence | Repository intelligence (Phase 6) | Repository manifest (languages, frameworks, runtimes, manifests, Docker, CI, infrastructure), symbol search with callers, resolved file dependencies, deterministic impact analysis (dependants, tests, routes, config, modules), most depended-upon files, external packages, unresolved imports, file tree. See [docs/repository-intelligence.md](docs/repository-intelligence.md) |
| Reports (page) | Reports (Phase 9) | Generate a report about an analysis, a plan or a code-engine run: an executive summary with the step-by-step chain (repository → analysis → plan → approval → run → changes → validation → tests → result, each passed / failed / skipped / pending / not executed / unavailable), then repository, analysis, plan, approval, run, changes, validation, tests, security, errors and warnings, limitations and timeline. Built only from stored data, immutable, de-duplicated, redacted; never claims success without a passing test run. Markdown and JSON export. See [docs/reports.md](docs/reports.md) |
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
- For the end-to-end tests: Chromium for Playwright (`cd e2e && npx playwright install chromium`)

## Getting started

```bash
npm install                 # also generates the Prisma client
node scripts/setup-env.mjs  # creates .env with a random JWT_SECRET and database password
npm run services:up         # starts postgres + redis via docker compose
npm run db:deploy           # applies migrations
npm run dev                 # web app on http://localhost:3000
npm run worker              # in a second terminal: the analysis worker
```

Analysis works without any API key. The planner and code engine need one: add `ANTHROPIC_API_KEY` to `.env` (or set
`AI_PROVIDER=baseline` for evidence-only plans without an LLM; the baseline cannot write code, so code-engine runs are
refused). Running the repository's tests also needs the sandbox (`SANDBOX_ENABLED=true` and Docker); the simplest way is
the container stack with `docker-compose.sandbox.yml` ([docs/deployment.md](docs/deployment.md)).

To present the whole workflow, follow the [demo runbook](docs/demo.md): which repository to use for each part, what to
check beforehand, and an offline fallback with a model stub.

## Environment variables

See [.env.example](.env.example). The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (its credentials must match `POSTGRES_*`) |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Used by `docker-compose.yml` to create the database. `POSTGRES_PASSWORD` is required (no default); it only takes effect when the database volume is first created. PostgreSQL and Redis are published on `127.0.0.1` only |
| `REDIS_URL` | Redis for the job queue and rate limiting |
| `JWT_SECRET` | ≥32-char secret used to HMAC session tokens before storage |
| `AI_PROVIDER` | Planner and code-engine provider: `anthropic` (default; needs `ANTHROPIC_API_KEY`) or `baseline` (deterministic evidence-only plans, no LLM; cannot write code, so code-engine runs are refused) |
| `ANTHROPIC_API_KEY` | Optional. Enables LLM planning (Phase 7) and code editing (Phase 8). Needed by the web app (checked) and the worker (used). Read from the environment only; never stored, logged or sent to the browser |
| `ANTHROPIC_MODEL` | Model for planning and editing, default `claude-opus-5-5` |
| `SANDBOX_ENABLED` | `false` (default): code-engine runs end with a diff and no repository code runs. `true`: approved test runs execute in disposable Docker containers (the worker needs Docker with Linux containers; see [security.md](docs/security.md#known-limitations)) |
| `SANDBOX_INSTALL_ENABLED` | `false` (default). `true` offers a separately approved, network-enabled dependency install (`npm ci --ignore-scripts`, pip wheels only) |
| `SANDBOX_RUNTIME`, `SANDBOX_IMAGE_*`, `SANDBOX_*_SECONDS`, `SANDBOX_MEMORY_MB`, `SANDBOX_CPUS`, `SANDBOX_PIDS` | Sandbox runtime (`runc`/`runsc`), digest-pinned images and limits; see [docs/code-engine.md](docs/code-engine.md#configuration) |
| `ENGINE_CONCURRENCY` | Planner and code-engine jobs the worker runs at once (default 1) |
| `WORKSPACE_DIR` | Where uploads and clones are stored temporarily (default: OS temp dir) |
| `MAX_UPLOAD_MB`, `MAX_EXTRACTED_MB`, `MAX_ZIP_ENTRIES`, `MAX_COMPRESSION_RATIO`, `MAX_FILE_KB` | Ingest safety limits |
| `CLONE_TIMEOUT_SECONDS`, `CLONE_DEPTH` | Clone limits |
| `OSV_ENABLED` | `true` (default) checks exact dependency versions against OSV.dev; `false` makes no OSV.dev requests. See [security.md](docs/security.md#outbound-network-osvdev) for what is sent |
| `OSV_TIMEOUT_SECONDS` | Time budget for the whole OSV.dev lookup of one analysis (default 90) |

## Scripts

| Command | What it does |
|---|---|
| `npm test` | All unit tests (Vitest, all workspaces), including the e2e tooling and the detection-benchmark regression check; the real-Docker sandbox tests are skipped |
| `PD_DOCKER_TESTS=1 npx vitest run --project sandbox` | Also runs the sandbox tests against a real Docker engine (pinned images are pulled if missing) |
| `npm run typecheck` | `tsc` across all workspaces |
| `npm run build` | Production build of the web app |
| `npm run db:migrate` | Create a new migration during development |
| `docker compose --profile app up -d --build` | The whole application in containers: migrations, web, worker ([docs/deployment.md](docs/deployment.md)) |
| `npm run e2e:up`, `npm run e2e`, `npm run e2e:down` | End-to-end tests (Playwright) against the production images with a model stub; `E2E_SANDBOX=1` adds the Docker sandbox ([docs/testing.md](docs/testing.md)) |
| `npm run bench:detection` | Issue-detection benchmark: precision and recall on the benchmark fixtures ([docs/benchmark.md](docs/benchmark.md)) |
| `npm run bench:agent -- --label stub` | Planner and code-engine evaluation against a running stack (stub or real model) |

## Security considerations

Repositories are untrusted input. The analysis **never executes** repository code: no installs, builds or scripts. Clones run with
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

The code engine (Phase 8) is the one place where file contents reach the LLM and where repository code can run, both
narrowly. The model sees only the redacted contents of files the approved plan names (never secret files; bounded),
and its edits must pass scope, policy and exact-match checks plus the analyzer's syntax and security re-inspection.
Repository code runs only after the user approves the exact, allowlisted command, and only in a disposable container
without network, secrets or host mounts, as an unprivileged user with resource limits; the network-enabled install
step is a separate switch and approval, off by default. Nothing is committed or pushed; the result is a patch. Enabling
the sandbox gives the worker Docker access, which is root-equivalent on the Docker host. See
[docs/code-engine.md](docs/code-engine.md#security-boundaries).

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Workspace, schema, auth, hardened ingest, repository scanner, job queue, base UI | ✅ Done |
| 2 | Tree-sitter adapters (JS/TS/Python/Java/C/C++), LOC, complexity, smells | Implemented and tested (automated E2E since Phase 10) |
| 3 | Secret detection, insecure-pattern rules, security dashboard | Implemented and tested (automated E2E since Phase 10) |
| 4 | Dependencies + OSV.dev, import graph, cycles, architecture view (API + Dependencies/Architecture tabs) | Implemented and tested (automated E2E with OSV.dev off since Phase 10) |
| 5 | API/DB/test/docs analyzers, explainable health score, demo project (Practices and Health tabs) | Implemented and tested |
| 6 | Repository intelligence layer: manifest, symbol index, dependency graph, impact analysis, agent context API (Intelligence tab) | Implemented and tested |
| — | Git history insights (previously planned as Phase 6) | Planned |
| 7 | AI engineering planner: provider layer (Anthropic default, deterministic baseline), evidence retrieval from the index, validated evidence-cited plans, Planner page | Implemented and tested |
| — | Evidence-cited recommendations and fix suggestions on findings | Planned |
| 8 | Code engine: plan approval, rebuilt analysed source, validated edits, approved tests in a disposable Docker sandbox with repair, patch download (no commit/push); planner moved to the worker | Implemented and tested (E2E with a stub model) |
| 9 | Reports: analysis, plan and run reports as immutable redacted snapshots, Reports page and report view, Markdown/JSON export, report API | Implemented and tested (E2E with a stub model) |
| 10 | Production images (web, worker, migrate) and compose, opt-in sandbox Docker access, GitHub Actions CI, Playwright E2E against the compose stack with a model stub, benchmark fixtures with ground truth (detection precision/recall, planner and code-engine success rates), manual real-model evaluation | Implemented and tested |

## Verification status

Every push to `main` and every pull request runs [CI](docs/ci.md): typecheck, unit tests, the production build,
migrations against an empty database, the sandbox against real Docker, and the Playwright end-to-end suite against the
production images with the sandbox off and on.

| Check | Result (2026-10-08) |
|---|---|
| `npm test` (Vitest, all workspaces) | **771 tests passing**, plus 4 real-Docker sandbox tests that run with `PD_DOCKER_TESTS=1` (passing) |
| `npm run typecheck`, `npm run build`, `npm audit` | Clean for all eleven workspaces; build succeeds; 0 known vulnerabilities |
| End to end (Playwright, production images, model stub) | 33 of 33 specs with the sandbox off, 33 of 33 with it on |
| Detection benchmark | Precision 97.3 %, recall 97.3 % ([results](benchmarks/results/detection.md)) |
| Planner and code-engine evaluation | Stub: 5 of 6 tasks. Real model: not run yet ([docs/benchmark.md](docs/benchmark.md)) |

The planner and code engine have been verified end to end only against the model stub, which runs the real provider code
over HTTP with scripted responses; the manual real-model evaluation has not been run yet.

What each phase was verified with, test by test and with its end-to-end check: [docs/verification.md](docs/verification.md).
