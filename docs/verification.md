# Verification status

What has been verified, phase by phase, with the dates of the end-to-end checks. The current totals are in the
[README](../README.md#verification-status); how to run each suite is in [testing.md](testing.md).

## Final audit follow-ups (2026-10-08)

After the Phase 10 audit: `next` 16.3.6 → 16.4.0 and patched Prisma CLI dependencies (`npm audit`: 0 vulnerabilities;
the regenerated Prisma client is unchanged and migrations show no drift); rate-limit keys no longer come from
client-controlled headers without `TRUST_PROXY=true` (2 tests); README and [demo runbook](demo.md). `npm test`: **771
tests passing**, `npm run typecheck` clean, `npm run build` succeeds. The demo project's tests cannot pass in the
sandbox, even with the install step, because its lockfile is abbreviated (reproduced in the pinned Node image: `npm ci
--ignore-scripts` installs 9 packages, `npm test` exits 127); the runbook uses `e2e/fixtures/tiny-node` for the test run.

## Phase 10

At the end of Phase 10, `npm test` (Vitest, all workspaces): **769 tests passing**, plus 4 real-Docker sandbox tests that run only with
`PD_DOCKER_TESTS=1` (all passing on 2026-10-08); `npm run typecheck` is clean for all eleven workspaces and
`npm run build` succeeds.

| Area (Phase 10) | Tests |
|---|---|
| Health check (ok, degraded without details, missing Redis, hanging dependency) | 3 |
| Model stub against the real prompt builders and output schemas (request kinds, plan, determinism, scoped exact edits, redacted lines, scripted failures) and the e2e ZIP writer | 6 + 2 |
| Benchmark scorer (matching by rule, file and line span, duplicates, acceptable and out-of-scope findings, order independence, rates, aggregation, schema), agent-evaluation summary, fixtures valid, detection results reproduce the committed ones exactly | 9 + 1 + 2 |

**End to end (Phase 10, on 2026-10-08)**, automated with Playwright against the production images (compose: PostgreSQL 17,
Redis 7, migrate, web, worker, model stub; OSV.dev off), on Docker 29.8 (Linux engine): **33 of 33 specs passed** with the
sandbox off (the default deployment) and **33 of 33** with `docker-compose.sandbox.yml` (the fixture's `npm test` ran in a
sandbox container without network and passed; no sandbox containers or volumes left). Service logs contained no keys,
passwords, task text or patch content. Detection benchmark: precision 97.3 %, recall 97.3 % (36 of 37 planted issues, one
false positive; [results](../benchmarks/results/detection.md)). Planner/code-engine evaluation against the stub: 5 of 6 tasks
(the stub's planner picks the wrong file of the import cycle, as expected of a script). The real-model evaluation has not
been run (no API key was available); see [docs/benchmark.md](benchmark.md). Found and fixed by the end-to-end run:
the sandbox override enabled the sandbox only in the worker, so the web tier refused test execution; it now sets the
switches (never the socket) for the web tier too.

| Area (Phase 9) | Tests |
|---|---|
| Report building and storage: analysis (completed, failed, in progress), plan (approved, superseded, rejected), run (tests passed, failed, not run, skipped, awaiting approval, in progress, failed, cancelled, discarded), no secrets/evidence/code in snapshots, hostile content, Markdown escaping, determinism, de-duplication (also under a race), historical snapshots, ownership, list filters and pagination | 16 |
| Report API (generate, list, filters, pagination, latest, export; validation, 401/403/404/429, other users' reports) and report UI (sections, statuses, partial reports, security findings, escaping, large reports, list, empty and failure states) | 6 + 8 |
| Code engine: a cancel requested while changes are applied is honoured (bug found by the Phase 9 end-to-end check) | 1 |

**End to end (Phase 9, on 2026-10-03)** with the production build, the worker, PostgreSQL, Redis and Docker (sandbox and
install step enabled; local model stub, no API key): reports were generated for an analysis, for a plan before and after
its approval, and for runs whose tests passed (a dependency-free project: `npm test` exit 0 in the sandbox → `TESTS_PASSED`,
every chain step passed), failed (the demo: exit 127 → `TESTS_FAILED`), were cancelled, waited for approval (`PARTIAL`) and
were discarded (the earlier report kept its result, the new one says `DISCARDED`). Regenerating unchanged data returned the
same report; another user got 404 everywhere; cross-site and unauthenticated requests were refused. No report contained a
secret, code or a diff, and logs carried ids and outcomes only. The Reports pages passed in headless Chrome (list and filter,
detail sections, a diff loaded from the run, the "diff no longer stored" case, generation from the analysis page, Markdown
download, dark mode, 390 px, no console errors). Details: [docs/reports.md](reports.md).

| Area (Phase 8) | Tests |
|---|---|
| Run lifecycle and gated status changes (`@pd/shared`, `@pd/db`) | 6 + 8 |
| Rebuilding the analysed source (exact-commit fetch, size limit, hash verification), archive retention | 8 + 4 + 4 + 5 |
| Edit scope, context, validation, re-inspection, diffs verified with `git apply`, providers | 38 + 7 + 4 |
| Sandbox (configuration, command allowlist, container flags, driver) and real Docker (isolation probe, network only for install, Python image, timeout and clean-up) | 19 + 4 |
| Worker orchestration (start/execute jobs, repair, budgets, cancellation, forged jobs, controls, stale sweep) | 16 |
| Run API (full flow with the real engine, validation, auth/ownership/Origin/rate limit) and run UI | 5 + 8 |

**End to end (Phase 8, on 2026-10-03)** with the production build, the worker, PostgreSQL, Redis and Docker, the sandbox
enabled and a **local stub of the model API** (no API key was configured; the real provider code ran over HTTP with
scripted responses): the demo project was analysed and planned in the worker; the gates held (run before plan approval
409, other user 404, cross-site POST 403, install while disabled 409, patch before review 409); the run rebuilt and
verified the source, applied two changes, waited for approval, ran `npm test` in the sandbox without network, and went to
review; the downloaded patch applied with `git apply` to a pristine copy; discard removed it. The demo's planted password
never reached the model, logs contained no task text, code or keys, and no containers, volumes or workspaces were left.
The UI flow passed in headless Chrome (dark mode, 390 px, no console errors). Two problems found on the way were fixed (a
wasted repair round when dependencies were missing; the run timeline at 390 px). Details:
[docs/code-engine.md](code-engine.md#end-to-end-verification-2026-10-03).

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
