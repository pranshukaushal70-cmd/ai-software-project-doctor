# Engineering planner (Phase 7)

The engineering planner turns a developer task ("Add rate limiting to the login endpoint") into a structured,
explainable engineering plan: affected files and symbols, implementation steps, test plan, configuration and dependency
changes, security and performance considerations, risks, a validation plan and a confidence. Every repository claim is
marked **VERIFIED**, **INFERRED** or **UNKNOWN** and cites the evidence it rests on.

It **plans only**. It never executes repository code or shell commands, installs packages, modifies files, commits,
pushes or opens pull requests. The deterministic repository index from Phase 6 is the source of truth; the LLM reasons
over facts from that index and its output is treated as untrusted input.

## Architecture

```
            ┌──────────────────────── apps/web ────────────────────────┐
 browser ──▶│ /planner page ─▶ /api/engineering/tasks[/:id[/plan]]     │
            │                     │ auth, ownership, Origin, rate limit│
            │                     ▼                                    │
            │   server/services/engineering-service.ts                 │
            │     │ reuses intelligence-service: graphFor (cached       │
            │     │ RepositoryGraph), stored manifest + routes;         │
            │     │ findings and package imports from the database      │
            └─────┼────────────────────────────────────────────────────┘
                  ▼
            ┌──────────────────── packages/agent (@pd/agent) ──────────┐
            │ context.ts   task → bounded evidence bundle (E1, E2, …)  │
            │ prompt.ts    stable system prompt + evidence message     │
            │ providers.ts LLMProvider: Anthropic | baseline | scripted│
            │ validate.ts  schema + index checks, scrubbing, confidence│
            │ planner.ts   runPlanner(context, provider, facts)        │
            └──────────────────────────────────────────────────────────┘
```

`@pd/agent` has no database or HTTP code: it takes a `RepositoryGraph` and plain data and returns plain data, so it is
unit-tested against a real index without a database or an LLM.

### Reused Phase 6 components (not duplicated)

| Need | Reused from Phase 6 |
|---|---|
| Keyword retrieval over symbols, files and routes | `RepositoryGraph.search` |
| Dependants, related tests and configuration | `RepositoryGraph.impact` (`directDependents`, `relatedTests`, `relatedConfig`) |
| Imports of a file | `RepositoryGraph.imports` |
| Symbol existence for validation | `RepositoryGraph.findSymbols` |
| Loading and caching the graph per analysis | `graphFor` in `intelligence-service.ts` |
| Languages, frameworks, runtimes, test frameworks and directories | `summary.intelligence.manifest` |
| HTTP routes | `summary.practices.api.list` (also the graph's routes) |
| Third-party packages per file | `FileDependency` rows of kind `EXTERNAL` |
| Existing findings | `Finding` rows (rule id, title, severity, location; never the evidence snippet) |
| Secret-file classification | `fileRole` from `@pd/analyzer/intelligence` |
| Credential redaction | `redactSecrets` from `@pd/analyzer/metrics` |
| Ownership | `getOwnedAnalysis` |

## Flow

1. **Task ingestion.** `POST /api/engineering/tasks` `{ analysisId, task, scope?, constraints? }` validates the input
   (10–2000 characters, no control characters, a repository-relative `scope` that contains files, at most 10 constraints
   of at most 300 characters), checks that the user owns the analysis and that it has a repository index, and stores an
   `EngineeringTask`. Nothing is planned or executed yet.
2. **Plan request.** `POST /api/engineering/tasks/:id/plan` checks ownership and that no plan for the task is in
   progress, resolves the configured provider (409 when none is configured), stores a `PENDING` `EngineeringPlan` with
   provider and model, queues an engineering job and responds `202`. The worker runs the rest (`executePlanJob` in
   `@pd/engine`; since Phase 8 planning no longer runs in the web process).
3. **Context retrieval** (`buildPlanningContext`, deterministic). In order, with the limits below:
   manifest facts (languages, frameworks, runtimes, test frameworks, test and source directories) → keyword search over
   the task and constraints → the highest-scoring files, their matching symbols and routes → for the top files: their
   imports, their direct dependants, related tests and related configuration (Phase 6 impact analysis) → packages those
   files import or whose names match the task → existing findings in those files or about the same topic. Each fact
   becomes a numbered evidence item (`E1`, `E2`, …) with kind, path, symbol, line, a one-line summary and the query that
   produced it. A `scope` restricts search hits and findings to that directory.
4. **Generation.** The provider receives the task and the evidence bundle only, never file contents.
5. **Validation** (`validatePlan`, deterministic; see below).
6. **Persistence.** The evidence bundle (`EngineeringPlanEvidence`), the validated plan, the validation report,
   provider metadata, token usage and duration are stored; the plan becomes `COMPLETED` or `FAILED` with a reason.
7. **Review.** `GET /api/engineering/tasks/:id/plan` returns the plan with its evidence; the UI polls it every 2 s while
   the plan is in progress.

### Context limits

| Limit | Value |
|---|---|
| Task length | 2000 characters; constraints 10 × 300 |
| Search hits considered | 60 |
| Candidate files | 12 (imports, dependants, tests and configuration are expanded for the top 5) |
| Symbols / routes / tests / configuration files | 40 / 12 / 12 / 10 |
| Imports and dependants per file | 6 each, impact depth 2 |
| Packages / findings | 15 / 20 (from the first 200 findings, most severe first) |
| Evidence items in total | 150 (`stats.truncated` is set when reached) |
| Model output | 16 000 tokens; plan lists 40 items, text fields 2000 characters, 12 evidence ids per item |

## Evidence model

Evidence items are facts the index states, e.g.

```
E7  [ROUTE] Express route POST /login is declared in src/routes/auth.ts:4.
E9  [TEST]  Test tests/auth.test.ts reaches src/routes/auth.ts through imports (distance 1).
E12 [FINDING] HIGH finding "Login endpoint without rate limiting" (api/auth-without-rate-limit) in src/routes/auth.ts:4.
```

Plan items cite them by id:

```json
{ "path": "src/routes/auth.ts", "change": "modify", "reason": "Declares POST /login",
  "certainty": "VERIFIED", "evidence": ["E7"], "flags": [] }
```

| Certainty | Meaning | Enforced by validation |
|---|---|---|
| VERIFIED | Stated by the cited evidence | Must cite at least one valid evidence id, else downgraded to INFERRED |
| INFERRED | Reasoned from evidence, not stated by it | Evidence ids must exist |
| UNKNOWN | Not established from the repository | Set by validation when a referenced file or symbol does not exist |

The evidence bundle is stored with the plan, so the evidence ids a plan cites stay resolvable even after the
repository is re-analysed.

## LLM provider abstraction

```ts
interface LLMProvider {
  readonly name: string;   // stored with the plan
  readonly model: string;
  generatePlan(context: PlanningContext): Promise<ProviderResult>; // { output: unknown, model, inputTokens, outputTokens, stopReason }
}
```

`output` is deliberately `unknown`: whatever a provider returns is validated before use.

| Provider | `AI_PROVIDER` | Notes |
|---|---|---|
| `AnthropicProvider` | `anthropic` (default) | Official `@anthropic-ai/sdk`. Model `ANTHROPIC_MODEL`, default `claude-opus-5-5`. Structured outputs: the plan's JSON schema (generated from the zod schema) is sent as `output_config.format`, with `effort: "high"`. The byte-stable system prompt is marked for prompt caching. Server-side fallbacks are enabled (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): if the model declines a request, it is retried once on Anthropic's recommended fallback model and the stored `model` is the model that actually answered. Refusals, truncation (`max_tokens`), invalid JSON, rate limits, credential errors and API errors become `ProviderError`s with user-safe messages |
| `BaselineProvider` | `baseline` | No LLM and no key. Builds an evidence-only plan (matching files, symbols, related tests, findings) with low confidence. Useful without an API key and as a reference |
| `ScriptedProvider` | (tests) | Returns scripted outputs or errors; all tests use it or a fake SDK client, so no test calls a paid API |

Adding a provider (OpenAI, a local model) means implementing `generatePlan` and adding it to `createProvider`; the
schema, validation, storage and UI do not change. Credentials are read from environment variables only, handed to the
SDK, and never stored, logged or returned.

## Validation and hallucination prevention

Prevention starts before generation: the model sees only numbered facts from the index, is told that unseen files do
not exist as far as it knows, must cite evidence ids and must mark certainty. Detection happens after generation, in
`validatePlan`, which never trusts the output:

| Check | Result |
|---|---|
| Output matches the plan schema | Otherwise the plan is **REJECTED** and stored as `FAILED` (`invalid-output`) with the schema issues |
| Cited evidence ids exist in the bundle | Unknown ids are removed (warning) |
| VERIFIED claims cite valid evidence | Otherwise downgraded to INFERRED (warning) |
| Paths are repository-relative (no `/`, `~`, drive letters, `\`, `..`, NUL) | Otherwise replaced by `[invalid path removed]` (error) |
| Files to modify/review/delete exist in the index | Otherwise flagged `nonexistent-file`, certainty UNKNOWN (error) |
| Files to create do not already exist | Otherwise flagged `file-exists` (warning) |
| Symbols to modify/review exist in that file | Otherwise flagged `nonexistent-symbol`, certainty UNKNOWN (error) |
| Existing tests are test files of the repository | Otherwise `test-not-found` (error) |
| Proposed test files look like test files | Otherwise `implausible-test-path` (warning) |
| Files named in steps exist or are listed in affected files | Otherwise `unlisted-step-file` (warning) |
| Plans do not touch secret files (`.env`, keys, credentials) | Flagged `secret-file` (warning) |
| No credentials in any text field | Redacted with the analyzer's secret patterns (error) |
| No shell commands in any text field (`npm install`, `curl`, `rm -rf`, `git push`, `bash -c`, `child_process`, …) | The text is replaced by `[shell command removed by validation]` (error) |
| Sizes | Lists, text and evidence lists are truncated to the limits above |

Flagged items stay in the plan, visibly marked, rather than disappearing silently. The report status is `PASSED`,
`WARNINGS`, `ERRORS` or `REJECTED`; the displayed confidence is the model's own confidence lowered by 0.10 per error
and 0.03 per warning, and the UI shows both.

## Security boundaries

- **No execution.** Nothing in the planner runs repository code, shell commands or package managers, or writes to the
  repository; the plan is data. Validation also removes commands from the plan text itself.
- **No secrets to or from the model.** The context contains paths, names, routes and one-line summaries: no file
  contents, no finding evidence snippets, no `.env` values (secret files are only ever paths). Model output is scrubbed of
  credentials before it is stored.
- **Untrusted output.** Schema parsing, index checks, path checks and text scrubbing run on every plan; the UI renders
  plan text as text (React escaping), never as HTML.
- **Authorization.** Every endpoint requires a session. Tasks are filtered by owner and by the analysis's repository
  owner; other users' tasks and analyses are 404. POSTs require a same-origin `Origin` header. Creating tasks and
  requesting plans share the `ai` rate limit (30 per user per hour).
- **Credentials.** Keys come only from the environment, are not stored in the database, and are never logged; provider
  errors are mapped to fixed messages.
- **Prompt injection.** Repository text reaches the model only as identifiers and summaries the indexer produced (file
  paths, symbol names, finding titles). A hostile repository can still choose its file and symbol names; the worst case
  is a misleading plan, which validation constrains to existing files and symbols and which nothing executes.

## Observability

Each plan logs one line (`component: planner`, `plan generated` / `plan failed`) with plan id, provider, model, duration,
input and output tokens, evidence count, validation status, error and warning counts, and failure reason. The task text,
prompt, plan content and credentials are never logged. The same metadata is stored on the plan row.

## Data model

| Model | Purpose |
|---|---|
| `EngineeringTask` | Owner, analysis, request, optional scope, constraints, timestamp |
| `EngineeringPlan` | One planning attempt: status (`PENDING`, `RUNNING`, `COMPLETED`, `FAILED`), provider, model, plan JSON, validation report and status, confidence, context statistics, tokens, duration, failure reason and user-safe error, timestamps |
| `EngineeringPlanEvidence` | The evidence bundle of a plan (`ref` E1…, kind, path, symbol, line, summary, source) |

All cascade from the user and the analysis. Migration: `20261005120000_engineering_planner`.

## Known limitations

- Retrieval is lexical (Phase 6 keyword search with light stemming): a task phrased with words that appear nowhere in
  file, symbol or route names can retrieve little, and the plan then says so through UNKNOWN claims and low confidence.
- Validation checks that referenced files and symbols exist, not that the plan is a good one.
- Plans run in the worker (engineering queue). A plan still in progress after 15 minutes (e.g. the worker stopped) is
  reported as failed. The provider is checked in the web tier when a plan is requested (so a missing configuration is
  reported at once) and created again in the worker, so both need the AI provider settings.
- Shell-command detection is pattern-based and errs on the side of removing text that names a command.

## Phase 8: the code engine

The planner is the first stage of the code engine:

```
task → plan (Phase 7, validated) → plan approval → edits generated, validated and applied in an isolated workspace
     → test-command approval → tests in a disposable sandbox (repairs within budget) → diff reviewed → patch download
```

The approved plan's files and tests scope what the engine may change, every step that runs repository code needs an
explicit approval, and tests run only in a disposable container without network or secrets. No branch, push or pull
request is created; the result is a patch the user downloads. Design, security boundaries, configuration and the
end-to-end verification: [code-engine.md](code-engine.md); endpoints: [api.md](api.md#code-engine-phase-8).
