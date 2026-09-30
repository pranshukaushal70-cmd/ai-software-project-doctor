# Security

## Threat model

The analyzer processes **untrusted repositories** on behalf of **authenticated users**. Main risks:

| Threat | Mitigation | Where |
|---|---|---|
| ZIP path traversal (`../`, absolute paths, drive letters) | Entry names normalised; any `..` segment or absolute path rejects the whole archive; resolved target must be inside the extraction dir | `analyzer/src/ingest/zip.ts` |
| ZIP symlink entries | Rejected (Unix mode `S_IFLNK`) | same |
| ZIP bombs | Entry-count limit, total-size limit, per-entry compression-ratio limit, **and** streamed byte counting (declared sizes are not trusted) | same |
| Non-ZIP uploads | Magic-byte check in the web tier and again in the worker | `web/server/services`, `zip.ts` |
| Malicious git repos | `core.hooksPath=/dev/null`, `core.symlinks=false`, `protocol.allow=never` + `protocol.https.allow=always`, no submodules, LFS smudge disabled, `GIT_CONFIG_NOSYSTEM`/`GIT_CONFIG_GLOBAL` isolated, minimal environment, `shell: false`, timeout + kill | `analyzer/src/ingest/clone.ts` |
| SSRF via clone URL | Only `https://github.com` and `https://gitlab.com`; no credentials, ports or other hosts; re-validated inside `cloneRepository` | `shared/src/repo-url.ts` |
| Git option injection | Branch names may not start with `-`; passed as `--branch=<b>`; `--` precedes positional args | same |
| Code execution | Repository code is never run: no installs, builds or scripts | whole pipeline |
| Leftover source code | Per-run workspace is deleted in `finally`; uploaded ZIPs are deleted after analysis | `worker/src/pipeline.ts` |
| Secrets in reports/logs | Detected secret values are masked before evidence is built (at most a public prefix such as `ghp_` remains); fingerprints use the variable name or rule, never the value; every evidence string passes a second redaction pass; pino redacts credential-like keys | `analyzer/src/security/secrets.ts`, `metrics/evidence.ts`, `shared/src/logger.ts` |

## Authentication

- Passwords: argon2id (19 MiB, t=2), never stored or logged in plain text.
- Sessions: 256-bit random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production). The database
  stores only `HMAC-SHA256(JWT_SECRET, token)`, so a database leak does not yield usable sessions.
- Login does a dummy argon2 verification for unknown emails so timing does not reveal registered accounts.
- CSRF: `SameSite=Lax` plus an `Origin` check on every mutating API request.

## Authorization

Every analysis lookup goes through `getOwnedAnalysis(userId, id)`, which filters by the repository owner and returns
404 (not 403) for other users' analyses so ids cannot be probed.

## Rate limiting

`rate-limiter-flexible` backed by Redis (in-memory fallback): login (per IP and per email), signup, analysis, upload,
and later AI and report generation.

## HTTP hardening

CSP, `X-Frame-Options: DENY`, `nosniff`, strict referrer policy, permissions policy, HSTS in production,
`X-Powered-By` removed. Errors use a uniform envelope and never include stack traces; each response carries
`X-Request-Id`.

## Known limitations (Phase 1)

- CSP allows `'unsafe-inline'` scripts because Next.js injects inline bootstrap scripts; nonce-based CSP is planned.
- Clone size is bounded by depth and timeout but not by bytes; a byte cap is planned with container sandboxing.
- Nested `.gitignore` files are not yet honoured by the scanner (only the root one).
