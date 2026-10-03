# Code engine (Phase 8)

The code engine turns an approved engineering plan (Phase 7) into a concrete, reviewable change: it rebuilds the
analysed source in an isolated workspace, has the model propose edits for exactly the files the plan names, validates
and applies them, and — only after a second approval — runs the repository's own tests in a disposable sandbox,
repairing failures within a budget. The result is a patch the user downloads and applies with `git apply`.

It never commits, pushes, creates branches or opens pull requests, never runs a command a model chose, and never runs
repository code outside a sandbox container. With the sandbox off (the default) no repository code runs at all.

## Flow and gates

```
plan (Phase 7, validated)
  ── gate 1: the owner approves the plan ─────────────────────────────── POST /plans/:id/approve
run QUEUED → MATERIALIZING → GENERATING → VALIDATING → APPLYING              (worker, "start" job)
  ├─ sandbox off, or no supported test setup ─────────────────────────────→ READY_FOR_REVIEW
  └─ AWAITING_APPROVAL (the exact test command, image and notes are shown)
       ├─ the user skips the tests ──────────────────────────────────────→ READY_FOR_REVIEW
       └─ gate 2: the user approves the command ───────────────────────── POST /runs/:id/execute
            [INSTALLING →] TESTING                                           (worker, "execute" job)
              ├─ tests pass ──────────────────────────────────────────────→ READY_FOR_REVIEW
              ├─ environment problem (failed install; dependencies needed
              │  but the install step not approved) ─────────────────────→ READY_FOR_REVIEW (not repaired)
              ├─ no iterations, tokens or time left ──────────────────────→ READY_FOR_REVIEW
              └─ REPAIRING → VALIDATING → APPLYING → [INSTALLING →] TESTING → …
READY_FOR_REVIEW → download the patch, or DISCARDED (stored code deleted)
any unfinished status → FAILED | CANCELLED
```

| Gate | Enforced where |
|---|---|
| A run needs an approved plan | `createRun` (`@pd/engine/control`); approval only for the task's latest completed plan |
| Repository code runs only after the user approved the command | `transitionRun` (`@pd/db`): a move into `INSTALLING`/`TESTING` matches only a row with `executionApprovedAt` set, or the update that records the approval (allowed only from `AWAITING_APPROVAL`) |
| The network-enabled install step needs its own approval | `transitionRun`: `INSTALLING` also requires `installApproved`; the server must enable it (`SANDBOX_INSTALL_ENABLED`) |
| One open run per plan | Serializable transaction in `createRun` |
| Lifecycle | The transition table in `@pd/shared/engine`; every status change is a compare-and-set with an audit event in the same transaction |

Because the gates are part of the database update, they hold however a job is triggered: a forged or duplicate
`execute` job for a run that is not approved does nothing (tested).

## Components

| Package | Role |
|---|---|
| `@pd/shared/engine` | Run statuses, transition table, budgets |
| `@pd/db` | Run tables (`EngineeringRun`, `EngineeringChange`, `SandboxExecution`, `EngineeringRunEvent`) and `transitionRun` |
| `@pd/analyzer` | `fetchCommit` (exactly the analysed commit), `verifyFiles` (hash check), `@pd/analyzer/inspect` (in-memory syntax and security re-inspection), `@pd/analyzer/classify` |
| `@pd/agent` | Edit scope and policy, bounded and redacted edit context, edit schema and prompt, `generateEdits`, deterministic edit validation, git-format diffs, `@pd/agent/checks` |
| `@pd/sandbox` | Allowlisted test setups, the Docker driver, output sanitising |
| `@pd/engine` | The worker jobs (`runEngineJob`, `executePlanJob`), run controls, materialisation, stale-run sweep; `@pd/engine/control` is the web tier's entry point (no sandbox or tree-sitter code) |
| `apps/worker` | `engineering` queue (planner and runs), sweeps |
| `apps/web` | Run API (see [api.md](api.md#code-engine-phase-8)) and the run panel on the Planner page |

## Rebuilding the analysed source

Analyses keep no source code, so each job rebuilds it in a fresh workspace that is deleted when the job ends:

- **GitHub/GitLab:** `fetchCommit` fetches exactly `Analysis.commitSha` (depth 1) with the hardened git configuration
  of the clone, no template directory (no hooks), a time limit and a disk limit (`MAX_EXTRACTED_MB`) enforced while git
  runs. A commit that is no longer available upstream fails the run with a clear message.
- **ZIP:** the uploaded archive, which is now kept for completed analyses until the analysis is deleted (an hourly sweep
  deletes archives no queued, running or completed analysis refers to; a failed analysis's archive is deleted at once).
  Analyses made before Phase 8 had their archive deleted and cannot be rebuilt.
- **Demo:** a copy of `demo/storefront`.

Every file the engine may read or change is compared with the SHA-256 the analysis recorded (`File.contentHash`); any
difference fails the run (`source-changed`), so a plan built from the index is applied to exactly the indexed code.

## Generating and validating edits

**Scope** comes from the approved plan only: files marked `modify`/`create`/`delete`, symbols marked `modify`, the plan's
existing and new tests, and its configuration changes; items the plan's validation flagged as invalid or nonexistent are
excluded. New test files that follow the repository's test conventions are also accepted (with a warning). Some paths
are never editable whatever the plan says: lockfiles; CI, container and deployment files; anything under `.github/`;
git metadata, `.gitattributes`/`.gitmodules` and hook configuration; package-manager configuration (`.yarnrc*`,
`.pnpmfile.cjs`, `bunfig.toml`, …); secret files; binary files. Package manifests change only when the plan approves a
dependency change.

**Context** (what the model sees) is the only place file contents leave the repository: the files in scope plus files
the plan names for review, never secret or binary files, at most 20 files, 64 KB each and 400 KB in total, with
credential-like values replaced by `<redacted>` and line endings normalised. The unredacted originals stay in the worker
and are what edits are applied to. The planner itself still sees no file contents.

**Edits** are exact search/replace blocks (`find` must occur exactly once), whole files for `create`, or deletions.
`validateEdits` checks the schema, scope, forbidden paths and every edit, preserves BOM and CRLF conventions, refuses
files that mix CRLF and LF, rejects edits touching a redacted value or adding a credential or control characters,
enforces limits (30 files, 2,000 changed lines, 256 KB per file), and scrubs secrets and shell commands from the
model's prose. `checkChanges` then re-parses and re-scans each changed file with the analyzer's own rules before and
after: a change that adds a syntax error or a security finding the file did not have is rejected (findings are compared
by content, so moved code is not "new"). Rejected changes are stored with their flags and shown to the user.

**Repair.** When every change is rejected, or the approved tests fail, the model gets the problems (validation messages
or the end of the redacted test output) and the current diff, and proposes further edits against the current files —
within the run's budgets: iterations (1–3, default 2), tokens (default 200,000) and time per job (default 20 minutes).
Failures caused by the environment (a failed install; tests that need dependencies when the install step was not
approved) are not repaired, because no code change can fix them.

The stored **patch** is cumulative: from the analysed source to the current result, in git format. The execute job
re-applies it to a freshly rebuilt source with `git apply`, which also proves the downloadable patch applies.

## Sandbox

Off unless `SANDBOX_ENABLED=true`. Test setups are resolved from the repository's files, never from a model:

| Setup | Test | Install (separate step, network on) |
|---|---|---|
| npm (`package.json` with a real `test` script) | `npm test` | `npm ci --ignore-scripts …` with a committed lockfile, otherwise `npm install --ignore-scripts --no-package-lock …` |
| pytest (Python test files) | `python -m pytest -q -p no:cacheprovider` | `pip install --only-binary=:all: --target /work/.pd-deps -r requirements*.txt pytest` |

Every command runs in its own container: `--network none` (except the install step), read-only root filesystem, noexec
`/tmp`, user `1000:1000`, `--cap-drop ALL`, `no-new-privileges`, limits on processes, memory (no swap), CPU, open files
and wall-clock time; no host directory, Docker socket or `.git` inside; only the template's environment variables. The
workspace is copied into a per-run volume (a one-off container that only runs `chown`, as root with `CAP_CHOWN` alone and
no network, hands it to the unprivileged user). Containers and the volume are removed afterwards, also after errors and
timeouts. Images are pinned by digest (`node:24-slim`, `python:3.12-slim`); unpinned images are refused. Output is
stripped of terminal escapes and control characters, redacted and truncated to the last 64 KB.
`SANDBOX_RUNTIME=runsc` adds gVisor where it is installed.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | `anthropic`, —, `claude-opus-5-5` | The editing model. `baseline` can plan but cannot edit: starting a run is refused with a clear message. Needed by the web tier (checked when a run starts) and the worker (used) |
| `SANDBOX_ENABLED` | `false` | Run approved tests in Docker; the worker needs a Docker engine with Linux containers |
| `SANDBOX_INSTALL_ENABLED` | `false` | Offer the network-enabled install step |
| `SANDBOX_RUNTIME` | `runc` | `runsc` for gVisor |
| `SANDBOX_IMAGE_NODE`, `SANDBOX_IMAGE_PYTHON` | pinned defaults | Must be `name:tag@sha256:…` |
| `SANDBOX_TIMEOUT_SECONDS`, `SANDBOX_INSTALL_TIMEOUT_SECONDS` | `300`, `300` | Per command |
| `SANDBOX_MEMORY_MB`, `SANDBOX_CPUS`, `SANDBOX_PIDS` | `1024`, `1`, `256` | Container limits |
| `ENGINE_CONCURRENCY` | `1` | Planner and code-engine jobs the worker runs at once |

## Security boundaries

The threat model rows are in [security.md](security.md#threat-model) ("Rebuilding analysed source", "Code-engine edits",
"Stored code-engine results", "Running repository tests"). In short:

- **Data to the model:** the task, the approved plan and the redacted contents of in-scope files (bounded, never secret
  files). Nothing else from the repository; no `.env` values.
- **Model output** is untrusted: it can only become a change through scope, policy, exact-match and limit checks plus the
  analyzer re-inspection, and only a human decides what happens with the patch.
- **Execution** only in the sandbox, only allowlisted commands, only after approval; the install step separately.
- **Stored code:** run patches and per-change diffs contain repository code (they must apply), are visible only to their
  owner, are never logged, are cleared on discard and deleted with the run.
- **Logs** carry ids, statuses, counts, exit codes and token usage; never task text, prompts, file contents or patches.
- **Docker access is root-equivalent on the Docker host**: run the worker on a dedicated host or VM, prefer rootless
  Docker and gVisor. With `runc`, containers share the host kernel.

## End-to-end verification (2026-10-03)

Against PostgreSQL 17, Redis 7, the production web build, the worker and Docker (Linux engine 29.8), with
`SANDBOX_ENABLED=true`, `SANDBOX_INSTALL_ENABLED=false` and `OSV_ENABLED=false`, on the demo project with the task "Add
rate limiting to the login endpoint". **No API key was configured, so the model was a local stub of the Messages API**
(`ANTHROPIC_BASE_URL`): the real provider code ran over real HTTP with scripted responses, and the real model's behaviour
remains to be verified.

| Step | Result |
|---|---|
| Analysis of the demo, plan in the worker | Completed; plan validation PASSED |
| Gates | Run before plan approval: 409; another user: 404; cross-site POST: 403; install while disabled: 409; patch before review: 409 |
| Start job | Source rebuilt and verified; 2 changes applied (`src/server.js` modified, a test created); waited for approval with `npm test` on the pinned `node:24-slim` image |
| Execute job | `npm test` ran in the sandbox without network; it failed with exit 127 (`vitest: not found`, dependencies not installed). First pass: one repair round, then review. This led to a fix (below); second pass: straight to review, "not repaired", 2 model calls in total |
| Patch | Downloaded as an attachment (`text/x-diff`, `private, no-store`); `git apply` succeeded on a pristine copy of the demo |
| Discard | Run `DISCARDED`; patch no longer available (409) |
| Data and logs | The demo's planted password never reached the model; the editor saw only `src/server.js`; the planner saw no file contents; web and worker logs contain no task text, patch code, API key or password |
| Clean-up | No sandbox containers, volumes or run workspaces left |
| UI (headless Chrome) | Plan approval, run start, approval card (command, image, notes; no install opt-in while disabled), approve, review, patch download via the link; dark mode; 390 px without horizontal scrolling; no console or page errors |

Found and fixed during the verification: (1) tests that fail because their dependencies are missing triggered a repair
round (a model call that cannot help); such failures now go to review as "not repaired"; (2) the run timeline squeezed
messages into a one-character column at 390 px; messages now take their own line on narrow screens.

## Known limitations

- The real model's editing behaviour has not been verified end to end (no API key was configured); unit tests use a
  scripted provider and a fake SDK client.
- Supported test setups: npm and pytest. Yarn/pnpm projects fall back to `npm install` with declared ranges. Most Node
  suites need the install step; Python tests always do (pytest is not in the image).
- The install step's network access is not restricted to the package registry.
- Files over 64 KB, files mixing CRLF and LF, and files the plan only marked for review cannot be edited.
- Redaction catches the analyzer's credential patterns; an unknown secret format in an in-scope file could reach the
  model.
- The time budget applies per job; time waiting for the user does not count.
- The UI follows the latest run of the latest plan; inline diffs stop after 400 lines per file (the download is complete);
  failed or cancelled runs cannot be downloaded.
- A hostile repository can try to steer the model through file contents; scope, validation, the re-checks, the approval
  gates and human review bound the effect.
