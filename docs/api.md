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
| GET | `/api/analysis/:id` | Status, stage, progress, scan summary, repository |
| GET | `/api/analysis/:id/files` | `?page=&pageSize=&kind=&sort=path|loc|complexity|duplication` paginated list with per-file metrics, or `?view=tree` for the nested tree |
| GET | `/api/analysis/:id/findings` | `?severity=HIGH,MEDIUM&category=&type=&path=&page=&pageSize=`. Most severe first; includes `facets` (counts by severity and type, scoped by `category`/`path` but not by the severity/type filters) |

`mode` is `LOCAL_ONLY` (default) or `AI` (AI mode takes effect in Phase 7).

Planned: `/architecture`, `/security`, `/dependencies`, `/git`, `/recommendations`, `/report`.
