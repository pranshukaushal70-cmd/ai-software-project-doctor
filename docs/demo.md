# Demo runbook

How to present the whole workflow, repository → analysis → plan → approval → code change → approved test run in the
sandbox → patch → report, and what to check beforehand so that nothing breaks in front of an audience.

## Choose a mode

| Mode | What runs | Needs |
|---|---|---|
| **Real model** (recommended) | The application stack with the Anthropic API planning and writing the change | `ANTHROPIC_API_KEY`, internet, Docker |
| **Offline fallback** | The end-to-end stack: the same production images with the deterministic model stub in place of the API | Docker only (after images are built) |

In the offline fallback the "model" is a script: plans are assembled from the repository index and the change it makes
is a one-line comment. Every other part (index evidence, plan validation, both approvals, the sandbox, the patch,
reports) is the real code. Say so when you present it.

`AI_PROVIDER=baseline` is not a demo mode for the code engine: the baseline plans without an LLM but cannot write code,
so runs are refused.

## Which repository to use for which part

| Part | Repository | Why |
|---|---|---|
| Analysis (findings, score, architecture, intelligence) | The bundled demo project (**New analysis → Try the demo project**) | Planted issues in every category ([demo/README.md](../demo/README.md)) |
| Plan, code change and a **passing** test run | `e2e/fixtures/tiny-node` uploaded as a ZIP | Dependency-free `node --test` suite: its tests pass in the sandbox without the install step or network |

Do not use the demo project for the test run. Its `package-lock.json.demo` is an abbreviated lockfile kept for the
dependency analysis (no transitive packages), so even with the install step `vitest` is never installed: the run ends
with `npm test` exit 127 and **Tests failed**. That is the correct, honest result, but not the one to show.

A small repository of your own also works for the test run if its tests are dependency-free, or if it commits a
complete `package-lock.json` and you enable the install step (below).

## Before the demo

On the demo machine, from the repository root.

1. **Configuration.** `node scripts/setup-env.mjs` (once) creates `.env`. Add:

   ```bash
   ANTHROPIC_API_KEY=...     # real-model mode only
   DOCKER_SOCKET_GID=0       # Docker Desktop; Linux: stat -c %g /var/run/docker.sock
   ```

   Leave `SANDBOX_INSTALL_ENABLED=false` for the tiny-node run. Set `OSV_ENABLED=false` if the venue's internet is
   unreliable (the Dependencies tab then lists packages without advisories).

2. **Start the stack with the sandbox** (read [deployment.md](deployment.md#sandbox-docker-access) first: the worker gets
   the Docker socket):

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.sandbox.yml --profile app up -d --build
   ```

   The first build takes several minutes; do it before the session. The web app is on http://localhost:3000.

3. **Pull the sandbox image** so the first test run does not wait for a download:

   ```bash
   docker pull node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
   ```

4. **Build the ZIP** for the test-run part (works the same in PowerShell and bash; avoid PowerShell 5.1's
   `Compress-Archive`, which writes backslash paths):

   ```bash
   git archive --format=zip -o tiny-node.zip HEAD:e2e/fixtures/tiny-node
   ```

5. **Check the model once** (real-model mode): sign in, upload `tiny-node.zip`, generate a plan for the task below and
   start a run. If the plan fails with "The AI provider rejected the configured credentials" or another provider error,
   fix the key or fall back to the offline mode.

6. **Reset the rate-limit counters** after rehearsing. Without a trusted proxy, every visitor shares the per-IP budget,
   so the whole instance allows 5 sign-ups per hour and 10 login attempts per 15 minutes
   ([security.md](security.md#rate-limiting)). Each user also has, per hour, 10 code-engine actions (starting a run
   and approving its tests count one each), 30 planner requests (creating a task and generating its plan count one
   each), 20 analyses and 10 uploads. This clears only the limiter keys (`rl:*`), never the job queues:

   ```bash
   docker compose exec -T redis redis-cli EVAL "local n = 0 for _, k in ipairs(redis.call('KEYS', 'rl:*')) do redis.call('DEL', k) n = n + 1 end return n" 0
   ```

   Create the account you will present with before the session.

## Script

1. **Sign in** and open **New analysis → Try the demo project**. While it runs, explain the pipeline stages shown on the
   page.
2. **Analysis tabs** of the demo project: *Security* (hard-coded admin password, SQL built by concatenation, MD5),
   *Dependencies* (outdated packages with advisories), *Architecture* (the orders ↔ pricing import cycle), *Practices*
   (CORS, unauthenticated `DELETE`), *Health* (score with every deduction listed), *Intelligence* (search a symbol, show
   its callers and the impact of changing `src/pricing.js`).
3. **Upload `tiny-node.zip`** (New analysis → Upload ZIP) and open the **Planner** for it. Task, for example:
   *"Add a subtract(a, b) function to src/math.js, export it, and add a test for it in test/math.test.js."*
   Show the plan: affected files, steps, test plan, each claim marked VERIFIED / INFERRED / UNKNOWN with evidence.
4. **Approve plan**, then **Run the code engine**. Show the per-file diff and its validation flags.
5. **Run the tests in the sandbox?** shows the exact command (`npm test`). **Approve and run tests**; the run ends in
   review with the test output (no network, read-only, unprivileged container).
6. **Download patch**; mention nothing is committed or pushed.
7. **Generate report** from the run: the executive summary's chain shows each step passed, and the report never claims
   success without a passing test run. Export it as Markdown.
8. **Security points**, if asked: sign up a second user in a private window and open the first user's analysis URL (404);
   the sandbox flags in `packages/sandbox/src/docker.ts`; the model never sees `.env` values or secret files.

## Offline fallback

Stop the application stack first; both stacks publish the web app on port 3000 (`down` without `-v` keeps its data):

```bash
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml --profile app down
```

Then start the end-to-end stack with the sandbox. It uses `e2e/stack.env`, never your `.env`, and has OSV.dev lookups off:

```bash
E2E_SANDBOX=1 npm run e2e:up                       # bash
$env:E2E_SANDBOX = "1"; npm run e2e:up             # PowerShell
```

Follow the same script on http://localhost:3000. `node scripts/e2e.mjs reset` clears its rate-limit counters, and
`npm run e2e:down` stops it and deletes its data.

## Known pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Planner: "No AI provider is configured" | `ANTHROPIC_API_KEY` missing in `.env` | Add it and recreate `web` and `worker` (`up -d` again) |
| "Sandboxed test runs are disabled on this server." | Started without `docker-compose.sandbox.yml` | Start with both compose files |
| `DOCKER_SOCKET_GID` error on start | Required by the sandbox override | Set it in `.env` (Docker Desktop: `0`) |
| Sign-up or login answers "Too many requests" | Shared per-IP budget used up while rehearsing | Reset the counters (step 6 above) |
| Demo project run ends with **Tests failed** (exit 127) | Abbreviated demo lockfile (see above) | Use tiny-node for the test run |
| Analysis of a GitHub URL fails | No internet at the venue | Upload a ZIP instead |
| Port 3000 already in use | The other stack (or `npm run dev`) is running | Stop it first |
