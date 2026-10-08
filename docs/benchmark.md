# Benchmark and evaluation (Phase 10)

A fixed set of benchmark repositories with machine-readable ground truth ([benchmarks/fixtures](../benchmarks/fixtures)),
and two evaluations over them:

| Evaluation | Measures | Deterministic | Where it runs |
|---|---|---|---|
| Issue detection | Precision and recall of the analyzer's findings, overall, per category and per rule | Yes | `npm test` (regression check), `npm run bench:detection` |
| Planner and code engine | Success rates of plans and of code-engine runs on developer tasks | With the stub: yes (it measures plumbing). With a real model: no (it measures the model) | `npm run bench:agent` against a running stack; CI (stub), manual workflow (real model) |

## Fixtures

| Fixture | Language | What is planted | Labelled categories |
|---|---|---|---|
| `storefront` | JavaScript | The demo project's issues ([demo/README.md](../demo/README.md)): secret, SQL injection, MD5, import cycle, complex function, five API problems, unindexed foreign keys, no migrations, few/skipped tests, no CI, thin README, broken link, no license, undocumented env vars | Security, secrets, code quality, architecture, API, database, testing, documentation |
| `py-inventory` | Python (Flask) | SQL injection, `shell=True`, `pickle.loads`, `eval`, MD5, `verify=False`, debug mode, hard-coded password, each **next to the safe variant** of the same call | Security, secrets |
| `ts-billing` | TypeScript | Import cycle, high complexity, deep nesting, duplicated block, long parameter list, empty catch; plus security-sensitive APIs used safely (sha256, `randomBytes`, `execFile` with arguments, parameterised SQL) | Code quality, architecture, security, secrets |
| `clean-lib` | JavaScript | Nothing: a tidy library with tests, README, license, CI and a lockfile. Every finding is a false positive | All except git/devops |

Each `ground-truth.json` ([schema](../benchmarks/src/ground-truth.ts)) lists:

- `labeledCategories`: the categories the fixture is **fully** labelled for. Within them every finding is either an
  expected issue (true positive) or a false positive; findings in other categories are reported as "out of scope".
- `expected`: one entry per planted issue, located by rule id, file (`path`, or `paths` for issues spanning files such
  as a cycle or a duplicated block) and, where meaningful, the line span it lies in (a function's lines for function-level
  rules).
- `acceptable`: findings that are true but not planted (for example "no API specification" in the demo); neither
  rewarded nor penalised.
- `tasks`: developer tasks for the agent evaluation, with the files a correct change must touch and files it must not.

**How the labels were made.** They were written from the code each fixture plants, not copied from analyzer output, and
every fixture contains clean code next to the planted issues so that false positives are measured. Two things the first
run revealed were kept as results rather than "fixed" in the fixtures: the demo's "few tests" issue is not reported
(a false negative of `testing/low-test-ratio`), and the clean library's short but complete README is flagged by the
word-count check of `documentation/incomplete-readme` (a false positive).

**Matching.** A finding matches an expected issue when the rule is the same, the file is the expected one and, if a line
span is given, the finding's line lies in it. Each issue is matched once; further findings of the same issue (one per
file of a cycle, say) are counted as duplicates, neither true nor false. Precision = TP / (TP + FP), recall =
TP / (TP + FN), micro-averaged over fixtures; `n/a` where a denominator is 0.

## Issue detection

```bash
npm run bench:detection              # print the summary
npm run bench:detection -- --write   # update benchmarks/results/detection.{json,md}
npm run bench:detection -- --check   # exit 1 if the results changed
```

It runs `runAnalyzers` from `@pd/analyzer/run`, the same function the worker's pipeline calls, on a temporary copy of
each fixture, offline (OSV.dev disabled, so dependency advisories are not part of the benchmark and the `DEPENDENCY`
category is labelled only for `clean-lib`). The results contain no timestamps and are committed:
[results/detection.md](../benchmarks/results/detection.md). `npm test` re-runs the benchmark and fails if the results
differ from the committed ones, so every change in analyzer behaviour shows up as a reviewed diff of the results.

Current result (analyzer 0.6.0): 36 of 37 planted issues found, 1 false positive, **precision 97.3 %, recall 97.3 %**.
These are small, purpose-built fixtures written by the same project as the rules; the numbers show that the rules work as
designed and catch regressions, not how the analyzer performs on arbitrary real-world code.

## Planner and code-engine evaluation

```bash
npm run e2e:up
npm run bench:agent -- --label stub [--repetitions N] [--run-tests] [--fixture name ...]
```

The harness ([benchmarks/src/agent.ts](../benchmarks/src/agent.ts)) drives a running stack through its HTTP API, so it
measures the product path: index → evidence → provider → plan validation → approval → edit generation and validation →
(optionally) sandboxed tests. For each task and repetition it creates the task, plans it, approves the plan, starts a
run, either approves the tests (`--run-tests`, when the sandbox offers them without an install step) or skips them, and
discards the result afterwards (no repository code is kept).

| Criterion | Success when |
|---|---|
| Planner | The plan completed, its validation is `PASSED` or `WARNINGS`, and it names every expected file for change |
| Code engine (end to end) | The run reached review, applied at least one change, changed an expected file, changed no forbidden file, and the tests passed if they ran. Rated over all attempts, so a failed plan is also an engine failure |

Results (JSON and Markdown) go to `benchmarks/results/local/` (git-ignored) or `--out`. They record the models each plan
reports, the requested model, repetitions, whether tests ran, the git commit, the fixture list and a digest of the ground
truth: everything needed to repeat a run, and never a key.

**Against the stub** (CI, both sandbox legs) the numbers prove the pipeline and its checks; the stub always edits the
file the evidence points to first, so its "success rate" says nothing about planning quality. The job fails only if the
harness fails.

### Real-model evaluation

Manual only, never part of pass/fail CI:

- **GitHub:** run the *Real-model evaluation* workflow (Actions → Run workflow) with a model id, repetitions and whether
  to run tests. The key is the `ANTHROPIC_API_KEY` secret of the `real-model-eval` environment ([ci.md](ci.md)).
- **Locally:** `PD_STACK=eval ANTHROPIC_API_KEY=… ANTHROPIC_MODEL=claude-opus-5-5 npm run e2e:up`, then
  `npm run bench:agent -- --label real-model --repetitions 3`, then `PD_STACK=eval npm run e2e:down`. The evaluation stack
  ([docker-compose.eval.yml](../docker-compose.eval.yml), project `pd-eval`) requires the key from the environment and
  never uses the stub; the e2e stack never uses a real key.

Reading the results: model output varies between runs, so report rates over several repetitions (the workflow allows up to 3: each repetition of the 6 tasks
uses a fresh user because of the per-user rate limits, and sign-ups are limited to five per hour) and compare runs only with the same models, fixtures
digest and repetitions. A rate is evidence about one configuration at one time, not a guarantee. Costs: every attempt
makes at least two model calls (plan, edit) and up to `maxIterations` repair calls.

## Adding a fixture

1. Create `benchmarks/fixtures/<name>/repo/` with the code (LF line endings are enforced by `.gitattributes`). Keep
   secrets obviously fake and avoid real credential formats, so secret scanning and Dependabot stay quiet.
2. Write `ground-truth.json` from what you planted, before running the analyzer. Include clean code next to the issues.
3. `npm run bench:detection -- --write`, review every false positive and negative in `results/detection.md`, and commit
   the fixture together with the updated results.
