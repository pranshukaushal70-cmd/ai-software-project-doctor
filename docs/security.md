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
| Malicious manifests and lockfiles | Read as data, never executed or installed: no `npm install`, `pip`, Maven/Gradle or `go` invocation. Parsers are line/regex based with bounded loops (no YAML/TOML/XML library that could expand entities or aliases); files over 20 MB are skipped; at most 20,000 dependencies and 2,000 dependency findings are stored | `analyzer/src/dependencies/` |
| Credentials in dependency specs | `https://user:token@host/…` in a version spec (git or tarball dependencies) is rewritten to `https://<redacted>@host/…` and passed through secret redaction before it is stored or shown | `dependencies/index.ts` (`redactSpec`) |
| Data sent to OSV.dev | Only ecosystem, package name and exact version, and only for registry packages not known to come from a private registry; see [Outbound network: OSV.dev](#outbound-network-osvdev) | `dependencies/osv.ts`, `dependencies/npm.ts` |
| Local services exposed on the network | `docker-compose.yml` publishes PostgreSQL and Redis on `127.0.0.1` only (Redis has no password); the database password comes from `.env` (`POSTGRES_PASSWORD`, required, no default) and `scripts/setup-env.mjs` generates a random one | `docker-compose.yml`, `.env.example` |
| Tokens in `.npmrc` / `.yarnrc.yml` | Read only to find registry URLs; just the `registry` / `npmRegistryServer` lines are parsed, so auth tokens are never stored or shown. Files over 64 KB are skipped | `dependencies/npm.ts` (`parseNpmRegistryConfig`) |
| Untrusted OSV.dev responses | Fixed HTTPS endpoint, redirects refused, per-request timeout, overall time budget, 32 MB response cap; advisory ids validated (`[\w.:-]{1,100}`), summaries flattened to one line, backticks removed and truncated to 240 characters; withdrawn advisories ignored; malformed responses mark the lookup `failed` instead of failing the analysis | `dependencies/osv.ts` |
| Hostile import specifiers | Import resolution is a pure string operation over the scanned file list; a specifier that normalises outside the repository root (`../../..`) is unresolved; only `tsconfig.json`/`jsconfig.json`/`package.json` files up to 512 KB are read, and `extends` chains are followed at most 5 levels and only inside the repository | `analyzer/src/architecture/resolve.ts` |

## Outbound network: OSV.dev

The dependency analysis (Phase 4) is the only part of the pipeline besides `git clone` that makes network requests. The
analyzer package itself stays network-free: the worker passes it a `fetch` function, and without one the lookup is
reported as `disabled`. Tests always inject a fake `fetch`.

| | |
|---|---|
| Endpoint | `https://api.osv.dev/v1/querybatch` (batches of up to 1,000 package versions) and `https://api.osv.dev/v1/vulns/{id}` (advisory details, at most 400 per analysis, 6 in parallel) |
| Sent | ecosystem, package name and exact version. Nothing else: no repository URL, file paths, source code or user data |
| Queried | registry packages with an exact version (from a lockfile or an exact pin). Version ranges, git/URL/path dependencies and workspace packages are never sent |
| Limits | 15 s per request, `OSV_TIMEOUT_SECONDS` (default 90) for the whole lookup, 32 MB per response, redirects refused |
| Failure | Never fails the analysis. The outcome is stored in `summary.dependencies.vulnerabilityScan.status`: `completed`, `partial` (some advisory details missing), `failed` (OSV.dev unreachable or invalid response), `disabled` or `skipped` (nothing to query), and the UI explains each one |
| Switch | `OSV_ENABLED=true` by default; set `OSV_ENABLED=false` to make no OSV.dev requests at all |

**Private packages.** A package that came from a non-public registry is not sent, so internal package names do not
leak. Public means `https://registry.npmjs.org`, `registry.yarnpkg.com` or `registry.npmmirror.com` for npm, and
crates.io for Cargo. Where a package came from is decided as follows:

| Source | How the registry is known |
|---|---|
| `package-lock.json` / `npm-shrinkwrap.json` | `resolved` URL of each entry |
| `yarn.lock` (classic, v1) | `resolved` URL of each entry |
| `pnpm-lock.yaml` | `tarball` URL in `resolution` (pnpm writes one only for packages that did not come from the default registry) |
| `bun.lock` | registry URL of each entry (empty means the default registry) |
| `yarn.lock` (Berry, v2+), pnpm/bun default registry, exact pins in `package.json` without a lockfile | not in the lockfile: decided from `.npmrc` (`registry=`, `@scope:registry=`) and `.yarnrc.yml` (`npmRegistryServer`, `npmScopes`) committed in the package's directory or any parent. The rule is conservative: a package counts as private as soon as one of those files points its scope, or the default registry, anywhere non-public. That includes a value taken from an environment variable (`${NPM_REGISTRY}`), which cannot be checked |
| `Cargo.lock` | `source` of each entry |
| PyPI (`requirements*.txt`, Poetry/uv/PDM locks, `Pipfile.lock`), Maven/Gradle, Go | **not recorded**: these files do not say which index served a package, so every package with an exact version is sent |

Only the registry lines of `.npmrc` and `.yarnrc.yml` are parsed. Auth tokens and other settings in those files are
never stored, logged or sent.

Two cases still send private package names: **PyPI, Maven and Go** packages, and npm packages whose private registry is
configured **outside the repository** (a user's `~/.npmrc`, CI environment variables, `bunfig.toml`). Deployments that
analyse such code should set `OSV_ENABLED=false`.

## Secret findings: context and triage

**Context.** Every secret finding records where it was found (`data.context`), and the evidence says so:

| Context | Files | Severity |
|---|---|---|
| `source` | production source | as detected |
| `configuration` | config files, committed `.env` | as detected |
| `template` | `.env.example`-style templates | only real token formats are reported |
| `test` | test files and fixtures | arbitrary passwords and connection strings: **INFO**, marked *likely intentional* ("detected in a security test fixture; likely intentional"). Real provider formats (AWS, GitHub, Stripe … keys, private keys, JWTs): **one level lower** only, with a request to verify the key is not live: real keys do get committed in tests |
| `documentation` | README, docs | as for tests, with "verify that this is not a real credential" |

Generated files (minified bundles, lockfiles, `*.d.ts`, `generated/`) are not scanned for secrets. Nothing is
ignored by directory: a test or docs file is still scanned, and a real key there is still reported.
Values that describe themselves as fake (`example-password`, `change-me…`, `not-a-real-…`, `<redacted>`,
`${VAR}`, `user:pass@`) are treated as placeholders; ordinary words such as "test" or "demo" inside a
password are not. `summary.security.totals.secretsByContext` counts secrets per context, and the
dashboard only raises the "rotate now" alert for secrets outside tests and documentation.

**Triage.** A repository owner can mark a finding **Expected** or **Ignored**, with an optional reason
(`FindingTriage`, see [api.md](api.md)). The decision is stored for the repository and the finding's
fingerprint (rule + path + stable key, never the secret value), so it carries over to re-analyses of the
same repository but never applies to a different finding, file or repository. Triaged findings stay in
results and summaries with a label; hiding them is an explicit, per-view filter.

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

## Known limitations

- CSP allows `'unsafe-inline'` scripts because Next.js injects inline bootstrap scripts; nonce-based CSP is planned.
- Clone size is bounded by depth and timeout but not by bytes; a byte cap is planned with container sandboxing.
- Nested `.gitignore` files are not yet honoured by the scanner (only the root one).
- Private-registry detection for the OSV.dev lookup cannot cover PyPI, Maven or Go, nor npm registries configured
  outside the repository (see above); use `OSV_ENABLED=false` for such code.
- Vulnerability results are only as complete as OSV.dev and the lockfile: packages without an exact version are listed as
  "not checked", and a listed advisory means the version is affected, not that the vulnerable code is reachable.
