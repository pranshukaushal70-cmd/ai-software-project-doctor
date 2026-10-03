# Reports (Phase 9)

A report is an immutable, redacted snapshot of what the Project Doctor recorded about one analysis, engineering plan or
code-engine run: what it found, planned, changed, validated and tested, and the final result. Reports are built only
from stored data. Nothing is inferred or re-run; what was not performed or not recorded is reported as such ("not
executed", "unavailable"), never as success.

## Report types

Each type covers the chain from the repository up to its subject:

| Type | Subject | Covers |
|---|---|---|
| `ANALYSIS` | an analysis | Repository, analysis (languages, structure, frameworks, findings, dependencies, health), security summary |
| `PLAN` | an engineering plan | The above, plus the task, the plan (content, validation, confidence) and its approval state |
| `RUN` | a code-engine run | The whole Project Doctor chain: repository → analysis → plan → approval → run → generated changes → validation → tests → final result |

Code changes and security are sections of these reports (not separate report types): the `RUN` report lists every
proposed change (applied or rejected, with additions/deletions and validation flags) and the security section combines
the analysis's secret, insecure-pattern and dependency findings with the edits the code engine blocked and how the
sandbox ran.

Every report starts with an executive summary and the **chain**: one entry per step with a state —
`passed`, `failed`, `skipped`, `pending`, `not_executed` or `unavailable` — and a one-line detail.

## Lifecycle, status and outcome

Generation is synchronous: a bounded set of database reads and a pure, deterministic build (no worker job, no model
call), so there is no "pending" or "generating" state. A failed generation returns an error and stores nothing.

| Field | Values | Meaning |
|---|---|---|
| `status` | `COMPLETE` | Everything the report covers had reached a final state when it was generated |
| | `PARTIAL` | Something it covers was still in progress or waiting for the user; generate it again later |
| `outcome` | `COMPLETED` | The analysis or plan finished |
| | `TESTS_PASSED` | The run is ready for review and its last approved test run passed |
| | `TESTS_FAILED` | The run is ready for review and its last approved test run failed or timed out |
| | `NOT_TESTED` | The run is ready for review without any test run (skipped, sandbox off, no supported setup) |
| | `DISCARDED`, `CANCELLED`, `FAILED` | As recorded |
| | `IN_PROGRESS`, `AWAITING_APPROVAL` | Still running, or waiting for the user (status `PARTIAL`) |

A run report never states success without a passing test run: `NOT_TESTED` is shown as "Not tested", the result step as
"unavailable".

**Snapshots.** A report never changes after it is stored. Generating again builds a new snapshot; if nothing changed (same
subject, same SHA-256 fingerprint of the snapshot) the existing report is returned instead of a duplicate, enforced by a
unique index on `(subjectKey, fingerprint)`. When underlying data changes later (a run is discarded, a plan approved),
older reports keep showing what was recorded at their time. Each report records the snapshot schema version
(`REPORT_VERSION`, currently 1) it was built with.

## Data model

`Report` (migration `20261008120000_reports`, which reshaped the unused placeholder table of the same name):

| Column | Purpose |
|---|---|
| `userId`, `repositoryId`, `analysisId`, `planId?`, `runId?` | Relationships (foreign keys, cascade on delete). Reports disappear with their user, repository, analysis, plan or run, following the existing retention rules |
| `type`, `subjectKey` (`"<type>:<subject id>"`) | What the report is about; used for de-duplication and "latest" |
| `status`, `outcome`, `title`, `summary`, `errorCount`, `warningCount` | Summary columns for lists and filters (no need to load the snapshot) |
| `version`, `fingerprint`, `data` (JSON) | The snapshot, its schema version and hash |
| `generatedAt`, `updatedAt` | Timestamps |

Indexes: `(userId, generatedAt)`, `(repositoryId, …)`, `(analysisId, …)`, `(planId, …)`, `(runId, …)`,
`(subjectKey, …)`, and the unique `(subjectKey, fingerprint)`. Relationships are relational columns; only the report
body is JSON, because its sections vary by type and are versioned as a whole.

**What a snapshot holds, and does not.** Bounded summaries copied from stored rows: the analysis summary fields, finding
counts by severity and category plus the 25 most severe findings (rule, title, location, triage state — never the
evidence), the plan's content and validation issues, run events (up to 200), changes (up to 200; path, operation, status,
flags, counts), sandbox executions with the last 2,000 characters of their (already redacted) output. It never contains
file contents, diffs, patches, finding evidence or secret values. Diffs are shown in the report page from the run itself,
while the run keeps them (discarding a run deletes them); source archives are never copied.

## Generation (`@pd/reports`)

| Module | Role |
|---|---|
| `collect.ts` | Loads the subject with the application's ownership checks and selective queries: finding counts are grouped in the database, only the most severe findings are read, run events/changes/executions are bounded, and the run's patch is never read (only whether it exists). Queries run in parallel; no N+1 |
| `build.ts` | Pure, deterministic builder: input rows → snapshot. Derives every state from stored statuses, timestamps and rows only |
| `sanitize.ts` | Passes every string of the snapshot through the analyzer's secret redaction and strips control characters, then bounds it |
| `store.ts` | Persists with de-duplication (also under concurrent requests), lists, gets and finds the latest report — always scoped to the owner |
| `markdown.ts` | Markdown export with repository text escaped |

The package has no web or HTTP code, so the API (and, if needed, the worker) can use it. Reports are generated on demand
from the UI or the API; nothing generates them automatically.

## API

All endpoints require a session; POST needs the same-origin `Origin` header. Other users' reports and subjects are
`404`. Details: [api.md](api.md#reports-phase-9).

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/reports` | `{ type, subjectId }` → `201` new report, or `200` with the unchanged existing one (`created: false`). Rate limit `report` (30 per user per hour) |
| GET | `/api/reports` | List (summaries, no snapshots), newest first; filters `repositoryId`, `analysisId`, `planId`, `runId`, `type`, `status`, `outcome`; `page`, `pageSize` (≤ 100) |
| GET | `/api/reports/latest?type=&subjectId=` | The newest report about a subject, or `null` |
| GET | `/api/reports/:id` | One report with its snapshot |
| GET | `/api/reports/:id/export?format=markdown\|json` | Download as an attachment (`private, no-store`) |

## UI

- **Reports** (navigation): the user's reports with type filter, outcome and status badges, error/warning counts and
  pagination; empty and error states.
- **Report page**: executive summary with the chain, then collapsible sections — Repository, Analysis, Engineering plan,
  Approval, Execution / run, Changes, Validation, Tests, Security, Errors and warnings, Limitations, Timeline. Long change
  lists start collapsed; diffs load from the run only when opened. Markdown and JSON downloads; "Generate again".
- **Generate report** buttons on the analysis page (analysis report) and on the Planner page (plan and run reports).

All repository-controlled text (paths, titles, task text, model prose, test output) is rendered as text by React; nothing
is rendered as HTML or Markdown.

## Security

- **Authorization:** every query is scoped to the user who owns the repository (`userId` and `repository.userId`), at
  generation and at every read; ids of other users' data are `404`. Tested at the service, API and database level.
- **Redaction:** reports are built from data that is already redacted (finding evidence is not even copied), and every
  string goes through `redactSecrets` again before storage. Secret findings show "secret detected", the rule and the
  location only.
- **Untrusted content:** text stays text. The UI relies on React escaping; the Markdown export escapes HTML and Markdown
  syntax and fences test output with a fence longer than any backtick run in it.
- **Prompt injection:** model prose quoted in a report (plan interpretation, run summary) is shown as prose; it cannot
  change a report's states, which come from stored statuses and test exit codes only.
- **Logging:** generation logs report id, type, status and outcome; never report content.

## Limitations

- Reports summarise stored data: they are only as complete as what the analysis, planner and code engine recorded, and
  findings come from deterministic rules (the absence of a finding is not proof that no problem exists).
- Lists inside a snapshot are bounded (findings 25, changes 200, events 200, executions 50, output tails 2,000
  characters); the report says when a list was shortened.
- Diffs are not part of reports; after a run is discarded its report still lists the changed files but no diff.
- Exports are Markdown and JSON; PDF and HTML exports are not implemented.
- Reports are generated on request, not automatically when an analysis or run finishes.
