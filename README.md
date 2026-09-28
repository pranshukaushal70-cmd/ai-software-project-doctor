# AI Software Project Doctor

> Diagnose your software before it breaks.

An engineering-analysis platform that takes a GitHub/GitLab repository URL or a ZIP upload and produces an
evidence-based health report. Deterministic analysis (parsing, metrics, secret detection, dependency and
architecture graphs) comes first; an LLM is used only afterwards, over structured and redacted findings, to
explain, prioritise and recommend, and it must cite the evidence it uses.

**Status: Phase 1 (foundation) complete; Phase 2 (code metrics & static analysis) implemented, end-to-end verification pending.** See [Roadmap](#roadmap) for what exists today and what is next.
Nothing described as "planned" below is implemented yet.

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
          ingest (hardened clone / safe ZIP) → scan → code metrics → [security → dependencies
          → architecture → git → scoring → redaction → AI reasoning → report]   (bracketed: planned)
```

| Path | Purpose |
|---|---|
| `apps/web` | Next.js 16 app: landing page, auth, dashboard, API route handlers |
| `apps/worker` | BullMQ worker that runs the analysis pipeline |
| `packages/analyzer` | Pure deterministic engine: no database, no network except `git clone` |
| `packages/db` | Prisma 7 schema, migrations and client |
| `packages/shared` | Types, zod schemas, errors, URL validation, logger |

More detail: [docs/architecture.md](docs/architecture.md), [docs/security.md](docs/security.md), [docs/api.md](docs/api.md).

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
bombs and size limits before anything is written. Details and threat model: [docs/security.md](docs/security.md).

## Roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 | Workspace, schema, auth, hardened ingest, repository scanner, job queue, base UI | ✅ Done |
| 2 | Tree-sitter adapters (JS/TS/Python/Java/C/C++), LOC, complexity, smells | Implemented; E2E pending |
| 3 | Secret detection, insecure-pattern rules, security dashboard | Planned |
| 4 | Dependencies + OSV.dev, import graph, cycles, architecture view | Planned |
| 5 | API/DB/test/docs analyzers, explainable health score, demo project | Planned |
| 6 | Git history insights | Planned |
| 7 | LLM provider layer (Anthropic default), evidence-cited recommendations, fix suggestions | Planned |
| 8 | Reports (PDF/JSON/Markdown/HTML) | Planned |
| 9 | Dockerised web/worker, CI, E2E tests, benchmark & evaluation | Planned |
