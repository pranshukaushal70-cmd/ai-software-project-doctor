# API

All responses use one envelope:

```json
{ "success": true, "data": { } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [], "requestId": "…" } }
```

Mutating requests must send an `Origin` header matching the app origin. Authenticated routes use the `pd_session`
cookie. Every response includes `X-Request-Id`.

Error codes: `VALIDATION_ERROR` 400, `UNAUTHENTICATED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409,
`PAYLOAD_TOO_LARGE` 413, `UNSAFE_ARCHIVE` 422, `CLONE_FAILED` 422, `RATE_LIMITED` 429 (with `Retry-After`),
`INTERNAL_ERROR` 500.

## Auth

| Method | Path | Body | Result |
|---|---|---|---|
| POST | `/api/auth/signup` | `{ name, email, password }` (password ≥ 10 chars) | 201 `{ user }` + session cookie |
| POST | `/api/auth/login` | `{ email, password }` | `{ user }` + session cookie |
| POST | `/api/auth/logout` | none | `{ loggedOut: true }` |
| GET | `/api/auth/me` | none | `{ user }` |

## Repositories & analyses

| Method | Path | Notes |
|---|---|---|
| GET | `/api/repositories` | The user's repositories with their latest analysis |
| POST | `/api/analysis` | JSON `{ url, mode }` **or** multipart `file=<zip>, mode`. Returns 202 `{ analysisId, status: "queued" }` |
| POST | `/api/analysis/demo` | No body. Analyses the bundled demo project ([demo/README.md](../demo/README.md)) in a `DEMO` repository the user gets once; rate limited like other analyses. Returns 202 `{ analysisId, status: "queued" }` |
| GET | `/api/analysis/:id` | Status, stage, progress, scan summary (including `summary.practices` from analyzer 0.5.0 on), repository, `healthScore` (0–100) and `scoreBreakdown` (grade, weighted score, cap, every dimension with its weight, score and deductions, caveats). Both are `null` before analyzer 0.5.0 or until the analysis completes |
| GET | `/api/analysis/:id/files` | `?page=&pageSize=&kind=&sort=path|loc|complexity|duplication` paginated list with per-file metrics, or `?view=tree` for the nested tree |
| GET | `/api/analysis/:id/findings` | `?severity=HIGH,MEDIUM&category=&type=&path=&triage=all\|untriaged\|triaged&page=&pageSize=`. Most severe first; includes `facets` (counts by severity and type, scoped by `category`/`path`/`triage` but not by the severity/type filters). Each finding has `triage: { status, reason, updatedAt } \| null`; `triage` defaults to `all`, so triaged findings are listed unless `untriaged` is requested |
| PUT | `/api/analysis/:id/findings/:findingId/triage` | JSON `{ status: "EXPECTED" \| "IGNORED", reason? }` (reason ≤ 500 chars). Stores the decision for the analysis's repository and the finding's fingerprint; returns `{ triage }`. 404 if the analysis is not yours or the finding is not in it |
| DELETE | `/api/analysis/:id/findings/:findingId/triage` | Clears the decision; returns `{ cleared }` |
| GET | `/api/analysis/:id/dependencies` | `?ecosystem=npm,PyPI&scope=all\|direct\|transitive&dev=include\|exclude\|only&vulnerable=true\|false&unused=true\|false&q=&manifest=&sort=name\|ecosystem\|manifest&page=&pageSize=`. Returns `{ summary, dependencies, page, pageSize, total, facets: { ecosystem } }`; vulnerable rows carry `vulnerability: { severity, fixedVersion, advisories }` (from OSV.dev) when the package is among the most severe listed in `summary` |
| GET | `/api/analysis/:id/architecture` | `?view=modules\|files&module=<dir>&cycles=true\|false&limit=1–2000` (default 300; `module` and `cycles` apply to the files view). Returns `{ summary, view, nodes, edges, total, truncated }`: most connected nodes first, edges addressed by node `key` (`file:<path>` / `module:<dir>`) with `inCycle` |

### Repository intelligence (Phase 6)

All are scoped to one analysis (an immutable snapshot); get a repository's latest analysis from `GET /api/repositories`.
Each returns `indexed: false` (and empty results) for analyses made before analyzer 0.6.0. Paths are repository-relative
(`src/auth/authenticate.ts`); absolute paths, `..` segments and backslashes are rejected (400).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/analysis/:id/manifest` | `{ manifest, totals, symbolLanguages, truncated }`: languages, frameworks, runtimes, manifests, lockfiles, Docker, CI, infrastructure, directories, file roles, secret files (paths only) |
| GET | `/api/analysis/:id/modules` | Modules at the architecture depth with file, test and symbol counts, merged with fan-in/fan-out/instability |
| GET | `/api/analysis/:id/symbols` | `?q=&kind=FUNCTION,CLASS&path=&exported=true|false&page=&pageSize=`. Definitions with path, line range, signature and number of resolved callers |
| GET | `/api/analysis/:id/references` | `?symbolId=` (resolved calls of that symbol) or `?name=` (every indexed call of that name), paginated; each with file, line, enclosing symbol and `resolved` |
| GET | `/api/analysis/:id/imports` | `?path=&direction=imports|importers`: a file's resolved imports (repository files, packages, standard library, unresolved) or the files importing it |
| GET | `/api/analysis/:id/impact` | `?type=file|symbol|module&target=&path=&depth=1–20`: dependencies, direct and transitive dependants (with distance), call sites, related tests, routes, configuration, affected modules, and a `graph` (`nodes`, `edges`) to draw |
| POST | `/api/analysis/:id/context` | Agent interface, JSON `{ operation, … }`: `manifest`, `search`, `find_symbol`, `find_references`, `file_imports`, `file_importers`, `related_tests`, `find_route`, `impact_analysis` (see [repository-intelligence.md](repository-intelligence.md#agent-interface)). Returns `{ indexed, operation, result }`. Read-only, but as a POST it needs the `Origin` header |

The repository tree, module graph and package list come from the existing `/files?view=tree`, `/architecture` and
`/dependencies`. The resource names suggested for this phase map onto these endpoints as follows:
`/api/repository/:id/tree` → `/files?view=tree`, `/manifest` → `/manifest`, `/modules` → `/modules`,
`/dependencies` → `/imports` (files) and `/dependencies` (packages), `/symbols` → `/symbols`, `/impact` → `/impact`.

`mode` is `LOCAL_ONLY` (default) or `AI` (AI mode takes effect in Phase 7).

For `/dependencies` and `/architecture`, `summary` is `null` (and the lists are empty) until that analysis module has run,
for example for analyses made by an analyzer version before 0.4.0.

Planned: `/security`, `/git`, `/recommendations`, `/report`.
