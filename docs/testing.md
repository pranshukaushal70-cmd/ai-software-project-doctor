# Testing (Phase 10)

Three layers, from fast and isolated to slow and complete. Everything here is deterministic; the real-model evaluation
is separate ([benchmark.md](benchmark.md)).

| Layer | Command | Needs | What it proves |
|---|---|---|---|
| Unit and integration | `npm test` | Node only | Every package in isolation (fake Prisma, fake SDK client, scripted providers), the e2e tooling, the benchmark scorer and the detection-benchmark regression check |
| Sandbox against Docker | `PD_DOCKER_TESTS=1 npx vitest run --project sandbox` | A Docker engine with Linux containers | Network off, read-only filesystem, limits, timeouts and clean-up with real containers |
| End to end | `npm run e2e:up && npm run e2e` | Docker, Chromium for Playwright (`npx playwright install chromium` in `e2e/`) | The production images, PostgreSQL, Redis, the worker and the real provider code over HTTP, in the browser and through the API |

## End-to-end tests

The stack is [docker-compose.e2e.yml](../docker-compose.e2e.yml) on top of the production compose file, driven by
[scripts/e2e.mjs](../scripts/e2e.mjs):

```bash
npm run e2e:up                  # build images, start, wait until healthy (project "pd-e2e")
npm run e2e                     # Playwright: API specs, then browser specs
npm run e2e -- --project api    # only the API specs; any Playwright arguments work
npm run e2e:logs                # web, worker and stub logs
npm run e2e:down                # stop and delete the stack's volumes
E2E_SANDBOX=1 npm run e2e:up    # the same with docker-compose.sandbox.yml (worker gets the Docker socket)
E2E_SANDBOX=1 npm run e2e
```

**Isolation from your environment.** The stack uses its own compose project, its own volumes and
[e2e/stack.env](../e2e/stack.env) (throwaway database password and session secret), never your `.env`. PostgreSQL and
Redis are not published to the host, so it runs next to `npm run services:up`; the web app (3000) and the stub (4010)
are published on localhost. Its API key is a fixed placeholder and `ANTHROPIC_BASE_URL` points at the stub, so the
end-to-end stack **cannot reach the real Anthropic API**. OSV.dev is off, so results do not depend on the network.

**The model stub** ([e2e/model-stub](../e2e/model-stub)) is a dependency-free Node server standing in for the Messages
API. The worker's real `AnthropicProvider` (SDK, structured-output request, error mapping) talks to it over HTTP. It
answers from the request alone: a plan naming the non-test file the evidence points to, and one exact, harmless edit (a
comment line) per file in the modify scope. `[stub:error]` or `[stub:refuse]` in a task's text script a 500 error or a
refusal. It records what it received (`GET /__stub/requests`, never headers or keys), which lets the specs check what
data reached "the model". Its unit tests build planner and editor messages with the real prompt builders and validate
its answers against the real output schemas, so a prompt or schema change that breaks the stub fails `npm test` first.
It proves plumbing, gates and safety checks, not planning or editing quality.

**What the specs cover** ([e2e/specs](../e2e/specs)), replacing the manual checks of earlier phases:

| Spec | Phase | Checks |
|---|---|---|
| `api/platform` | 1, 10 | Health endpoint, request ids, CSP, cookie flags (`HttpOnly`, `Secure`, `SameSite=Lax`), 401 without a session, 403 for cross-site and Origin-less POSTs, wrong password |
| `api/analysis` | 2–5 | Demo analysis through the worker; every planted issue at its file; files, dependencies (OSV off), architecture cycle; triage set and cleared; another user gets 404 everywhere; ZIP upload analysed; path-traversal archive fails safely |
| `api/intelligence` | 6 | Manifest (no secret values), modules, symbols, references, importers, impact, agent context; path validation; isolation |
| `api/engine` | 7–8 | Plan via the stub (provider, model, validation; the planner sees no file contents); provider error and refusal end the plan with safe messages; gate 1 (no run before approval, 404/403); edits only to the planned file (the editor sees only the scope); gate 2 (no execution while the sandbox is off; with `E2E_SANDBOX=1`, `npm test` runs without network and passes); install step refused; patch is a private attachment that `git apply` applies to the fixture, whose tests still pass; discard deletes it |
| `api/reports` | 9 | Analysis, plan and run reports; de-duplication; latest; exports (headers, no secrets, no diffs); isolation; strict validation |
| `ui/app` | 1, 5, 6, 8, 9 | Sign-up and redirects; demo analysis started from the UI and every tab rendered; Intelligence tab; 390 px without horizontal scrolling; planner shows the reviewed run, report opens, Reports page; no page or console errors |

`E2E_SANDBOX` must match the stack: the engine spec asserts the run's `sandbox.enabled` against it, so a misconfigured
stack fails rather than silently skipping the sandbox checks.

**Fixture.** [e2e/fixtures/tiny-node](../e2e/fixtures/tiny-node) is a dependency-free Node project whose `npm test`
passes without the install step. `.gitattributes` keeps fixture files LF on every platform, because the analyzer and the
code engine see bytes (hashes, line numbers and patches would otherwise differ on Windows checkouts).

**Users and rate limits.** Global setup creates two users (`owner`, `intruder`) and a browser session; the browser spec
signs up one more. The web tier's rate limits (five sign-ups per hour per client address, per-user budgets for analyses,
plans and runs) would stop a second run against the same stack, so `npm run e2e` first clears the limiter counters
(`rl:*` keys) in the e2e stack's own Redis (`node scripts/e2e.mjs reset`); the job queues are not touched, and the
limits themselves are unchanged and covered by unit tests. Playwright runs with one worker so analyses can be shared
between specs.

## In CI

See [ci.md](ci.md): the end-to-end job runs twice, with the sandbox off (the default deployment) and on.
