# AI Software Project Doctor

> Diagnose your software before it breaks.

An engineering-analysis platform that takes a GitHub/GitLab repository URL or a ZIP upload and produces an
evidence-based health report. Deterministic analysis (parsing, metrics, secret detection, dependency and
architecture graphs) comes first; an LLM is used only afterwards, over structured and redacted findings, to
explain, prioritise and recommend, and it must cite the evidence it uses.

**Status: Phase 1 (foundation) complete. Phases 2 (code metrics & static analysis), 3 (secret & insecure-pattern
detection) and 4 (dependency & architecture analysis) are implemented and unit-tested; end-to-end testing against
PostgreSQL and Redis is pending until Docker is available.** See [Roadmap](#roadmap) and
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
          → architecture → [git → scoring → redaction → AI reasoning → report]   (bracketed: planned)
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
| All findings | — | Every finding with evidence, impact and recommendation, filterable by severity and type |

The same data is available from the API, including `GET /api/analysis/:id/dependencies` and
`GET /api/analysis/:id/architecture` ([docs/api.md](docs/api.md)).

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
node scripts/setup-env.mjs  # creates .env with a random JWT_SECRET
npm run services:up         # starts postgres + redis via docker compose
npm run db:deploy           # applies migrations
npm run dev                 # web app on http://localhost:3000
npm run worker              # in a second terminal: the analysis worker
```

## Environment variables

See [.env.example](.env.example). The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis for the job queue and rate limiting |
| `JWT_SECRET` | ≥32-char secret used to HMAC session tokens before storage |
| `ANTHROPIC_API_KEY` | Optional. Enables AI mode (Phase 6). Never sent to the browser |
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

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Workspace, schema, auth, hardened ingest, repository scanner, job queue, base UI | ✅ Done |
| 2 | Tree-sitter adapters (JS/TS/Python/Java/C/C++), LOC, complexity, smells | Implemented; E2E pending |
| 3 | Secret detection, insecure-pattern rules, security dashboard | Implemented; E2E pending |
| 4 | Dependencies + OSV.dev, import graph, cycles, architecture view (API + Dependencies/Architecture tabs) | Implemented and unit-tested; E2E pending |
| 5 | API/DB/test/docs analyzers, explainable health score, demo project | Planned |
| 6 | Git history insights | Planned |
| 7 | LLM provider layer (Anthropic default), evidence-cited recommendations, fix suggestions | Planned |
| 8 | Reports (PDF/JSON/Markdown/HTML) | Planned |
| 9 | Dockerised web/worker, CI, E2E tests, benchmark & evaluation | Planned |

## Verification status

Verified without Docker, on unit and component level (Vitest, run one file at a time) and with `tsc`:

| Area | Tests |
|---|---|
| Analyzer: dependencies (all parsers, CVSS, OSV client with a fake `fetch`, private-registry withholding, end-to-end on temporary repositories) | 53 passing |
| Analyzer: architecture (graph algorithms, resolver for all languages, cycles, layers, coupling, modules, parsed real files) | 32 passing |
| Analyzer: metrics, security, scanner, ZIP (regression) | 31, 142, 18, 23 passing |
| Worker: pipeline (fake Prisma, fake OSV.dev: vulnerable package, import cycle, OSV outage, OSV disabled, retry clean-up) and row mapping | 7 + 12 passing |
| Web API: `/dependencies` and `/architecture` route handlers (mocked session and Prisma; auth, ownership 404, validation, filters) and their services | 13 + 7 + 6 passing |
| Web UI: Dependencies and Architecture panels, graph layout, tabs, overview notice (server-rendered markup) | 8 + 6 + 6 + 6 passing |
| Shared and existing web tests | 17 + 19 passing |
| Typecheck `@pd/analyzer`, `@pd/shared`, `@pd/worker`, `@pd/web` | clean |

**Pending until Docker is available:**

- End-to-end runs against **PostgreSQL and Redis**: real migrations, worker and web app together, a real queue, and
  persisted `Dependency`/`ArchitectureNode`/`ArchitectureEdge` rows read back through the API. This applies to Phases 2–4.
- Checking the new tabs in a browser (graph rendering, dark mode, narrow screens, interactive filters).
- A live OSV.dev lookup (all tests use a fake; no test calls the network).
- `next build` (not run on the development machine because of memory limits) and `test/clone.test.ts` (needs git and network).
