# Continuous integration (Phase 10)

Two GitHub Actions workflows with a strict split: [ci.yml](../.github/workflows/ci.yml) is deterministic and uses no
secret; [real-model-eval.yml](../.github/workflows/real-model-eval.yml) is the only place a real model is called, and it
runs only when started by hand.

## ci.yml

Triggers: pushes to `main`, every pull request, manual. Permissions: `contents: read` only. Superseded runs of the same
branch are cancelled. Actions are pinned by commit SHA; checkout does not persist credentials.

| Job | Steps |
|---|---|
| `checks` | `npm ci`; the committed Prisma client matches `prisma generate`; `npm run typecheck`; `npm test` (incl. the detection-benchmark regression test); `npm run build`; migrations applied to an empty PostgreSQL 17 service and diffed against `schema.prisma` (`prisma migrate diff --exit-code`: a schema change without a migration fails); all compose files validated (`config --quiet`, which does not print the resolved environment) |
| `sandbox-docker` | The real-Docker sandbox tests (`PD_DOCKER_TESTS=1`) on the runner's Docker engine |
| `e2e` (matrix `sandbox: off, on`) | Build the images, start the e2e stack, Playwright, then the planner/code-engine evaluation against the model stub; uploads the Playwright report, traces and evaluation results; prints service logs on failure; always removes the stack |

The `on` leg mounts the runner's Docker socket into the worker container. That is acceptable on a GitHub-hosted runner,
which is a disposable VM per job; do not copy it to self-hosted runners that are shared or long-lived
([deployment.md](deployment.md#sandbox-docker-access)). GitHub-hosted runners have no gVisor, so the sandbox runs with
`runc` there.

Pull requests from forks run `ci.yml` with a read-only token and no secrets; nothing in it needs one.

## real-model-eval.yml

- **Trigger:** `workflow_dispatch` only. No `push`, `pull_request`, `pull_request_target` or `schedule` trigger, so it
  cannot run for a pull request or a fork; starting it needs write access to the repository.
- **Secret:** `ANTHROPIC_API_KEY` in the `real-model-eval` environment. Add required reviewers to that environment to
  make every run need an approval. The key is passed only to the step that starts the stack, from where compose hands it
  to the web and worker containers; it is never written to a file or printed (GitHub also masks it).
- **Inputs:** model id (validated), repetitions (1–3), whether to run the fixtures' tests in the sandbox.
- **Output:** the evaluation JSON and Markdown as an artifact (90 days) and in the job summary. The job fails only when
  the stack or the harness fails, never because of a success rate ([benchmark.md](benchmark.md#real-model-evaluation)).

## Running the same checks locally

```bash
npm ci && npm run typecheck && npm test && npm run build
PD_DOCKER_TESTS=1 npx vitest run --project sandbox
npm run e2e:up && npm run e2e && npm run bench:agent -- --label stub && npm run e2e:down
```

## Known limitations

- No Docker layer cache between CI runs: each end-to-end leg builds the images from scratch (several minutes).
- No lint step: the repository has no linter configured (`npm run lint` has nothing to run).
- The CI e2e legs use GitHub-hosted runners; gVisor (`runsc`) is not exercised in CI.
