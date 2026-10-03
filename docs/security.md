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
| Code execution | The analysis never runs repository code: no installs, builds or scripts. The only exception is the code engine's sandbox (Phase 8): off by default, only allowlisted commands, only after the user approves them, only in disposable isolated containers (see below) | whole pipeline; `sandbox/src/` |
| Leftover source code | Per-run workspaces are deleted in `finally`. An uploaded ZIP is deleted at once when its analysis fails; the archive of a completed analysis is kept (mode `0600`, under `WORKSPACE_DIR/uploads`, random UUID name) so the code engine (Phase 8) can rebuild the analysed source, and only until the analysis is deleted: the worker sweeps `uploads/` hourly and deletes every archive that no queued, running or completed analysis refers to (archives younger than an hour are skipped, because the file is written just before its repository row). Analyses made before Phase 8 had their archives deleted, so the code engine cannot rebuild them | `worker/src/pipeline.ts`, `worker/src/uploads.ts` |
| Rebuilding analysed source (Phase 8) | Git sources are re-fetched at exactly the analysed `commitSha` (validated as a full hex commit id), depth 1, with the same hardened git configuration as the clone, no template directory and therefore no hooks, a time limit and a disk limit (`MAX_EXTRACTED_MB`, enforced while git runs by killing it). Rebuilt files are compared with the analysis's `File.contentHash` before use; stored paths are re-checked (repository-relative, inside the workspace, regular files only, symlinks not followed). Nothing is executed | `analyzer/src/ingest/clone.ts` (`fetchCommit`), `analyzer/src/ingest/verify.ts`, `engine/src/materialize.ts` |
| Secrets in reports/logs | Detected secret values are masked before evidence is built (at most a public prefix such as `ghp_` remains); fingerprints use the variable name or rule, never the value; every evidence string passes a second redaction pass; pino redacts credential-like keys | `analyzer/src/security/secrets.ts`, `metrics/evidence.ts`, `shared/src/logger.ts` |
| Malicious manifests and lockfiles | Read as data, never executed or installed: no `npm install`, `pip`, Maven/Gradle or `go` invocation. Parsers are line/regex based with bounded loops (no YAML/TOML/XML library that could expand entities or aliases); files over 20 MB are skipped; at most 20,000 dependencies and 2,000 dependency findings are stored | `analyzer/src/dependencies/` |
| Credentials in dependency specs | `https://user:token@host/…` in a version spec (git or tarball dependencies) is rewritten to `https://<redacted>@host/…` and passed through secret redaction before it is stored or shown | `dependencies/index.ts` (`redactSpec`) |
| Data sent to OSV.dev | Only ecosystem, package name and exact version, and only for registry packages not known to come from a private registry; see [Outbound network: OSV.dev](#outbound-network-osvdev) | `dependencies/osv.ts`, `dependencies/npm.ts` |
| Local services exposed on the network | `docker-compose.yml` publishes PostgreSQL and Redis on `127.0.0.1` only (Redis has no password); the database password comes from `.env` (`POSTGRES_PASSWORD`, required, no default) and `scripts/setup-env.mjs` generates a random one | `docker-compose.yml`, `.env.example` |
| Tokens in `.npmrc` / `.yarnrc.yml` | Read only to find registry URLs; just the `registry` / `npmRegistryServer` lines are parsed, so auth tokens are never stored or shown. Files over 64 KB are skipped | `dependencies/npm.ts` (`parseNpmRegistryConfig`) |
| Untrusted OSV.dev responses | Fixed HTTPS endpoint, redirects refused, per-request timeout, overall time budget, 32 MB response cap; advisory ids validated (`[\w.:-]{1,100}`), summaries flattened to one line, backticks removed and truncated to 240 characters; withdrawn advisories ignored; malformed responses mark the lookup `failed` instead of failing the analysis | `dependencies/osv.ts` |
| Hostile files read by the practices analyzers (Phase 5) | Text is matched with regular expressions and small parsers with bounded loops (no YAML/XML library); nothing is executed or connected to. Files are read one at a time from the scanner's list (no symlinks, size limit applies). Committed coverage reports under `coverage/`, a directory the scanner skips, are read only when both the directory and the file are real (`lstat`, not symlinks) and at most 20 MB, so a crafted repository cannot point the read outside its tree. Environment-variable findings record variable names only, never values | `analyzer/src/practices/` |
| Demo project | `demo/storefront` contains deliberate vulnerabilities and a made-up password. It is never run, built or installed: the worker copies it into the analysis workspace and analyses the copy. Its manifests are stored as `*.demo` so dependency scanners do not raise alerts for it in this repository | `demo/`, `worker/src/pipeline.ts` |
| Repository index (Phase 6) | Symbols come from the existing parse (no execution); the manifest and resolver read only small, known configuration files from the scanned list and never secret files (`.env` and non-template variants, `.npmrc`, `.pypirc`, `.netrc`, private keys, keystores), which are listed by path only. Repository-supplied version strings must match a strict pattern. Signatures are redacted like evidence; no file contents are stored. Query paths must be repository-relative and are matched against stored rows only, never opened. Every intelligence endpoint checks session and ownership; results and traversals are bounded (depth ≤ 20, ≤ 500 entries per list) | `analyzer/src/intelligence/`, `web/server/services/intelligence-service.ts`, `shared/src/schemas.ts` (`repoPathSchema`) |
| Code-engine edits (Phase 8) | **File contents reach the LLM here, and only here.** Only files the approved plan names are shown, never secret files (`.env` variants, keys, `.npmrc` …) and never binary files; at most 20 files, 64 KB each, 400 KB in total; credential-like values are replaced with `<redacted>` first, and the unredacted originals never leave the worker. Model output is untrusted: schema-checked; every change must be inside the plan's scope; lockfiles, CI/container/deployment files, git metadata, git configuration and hooks, package-manager configuration and secret files are never editable whatever the plan says; package manifests only with an approved dependency change; each `find` must match the original exactly once; edits touching a redacted value, adding credentials or control characters are rejected; limits of 30 files, 2,000 changed lines and 256 KB per file. Each changed file is re-parsed and re-scanned with the analyzer's own rules before and after: new syntax errors or new security findings reject the change. Commands in the model's prose are removed. Nothing is executed and nothing is written outside the run's workspace | `agent/src/edit-*.ts`, `agent/src/diff.ts`, `analyzer/src/inspect/` |
| Stored code-engine results (Phase 8) | A run stores its cumulative patch and per-change diffs, which contain repository code (changed and context lines): it has to apply with `git apply`, so it is not redacted. It is never logged (run logs carry ids, statuses, counts and token usage only), is visible only to the run's owner, is cleared when the user discards the result, and is deleted with the run, plan, analysis or user. Model-written code was checked for new credentials before it was accepted | `engine/src/orchestrator.ts`, `engine/src/control.ts` |
| Running repository tests (Phase 8 sandbox) | Off unless `SANDBOX_ENABLED=true`, and then only after the user approves the exact command for that run. Commands come from a fixed allowlist chosen from the repository's files (`npm test`, `pytest`), never from a model. Each command runs in its own disposable container: `--network none`, read-only root filesystem, noexec `/tmp`, user `1000:1000`, `--cap-drop ALL`, `no-new-privileges`, limits on processes, memory (no swap), CPU, open files and wall-clock time; no host directory, Docker socket or `.git` inside, and only the template's environment variables (no API keys, database or Redis URLs). The workspace is copied into a per-run volume; a one-off container that runs only `chown` (root with `CAP_CHOWN` alone, no network) hands it to the unprivileged user. Containers and volume are removed afterwards, also after errors and timeouts. The dependency install is a separate container with network access, behind its own switch (`SANDBOX_INSTALL_ENABLED`, off by default) and its own approval; it never runs lifecycle scripts (`npm ci --ignore-scripts`) and installs Python packages as wheels only (`--only-binary=:all:`). Images are pinned by digest; unpinned images are refused. Output is stripped of terminal escapes and control characters, redacted and truncated to 64 KB. `SANDBOX_RUNTIME=runsc` adds gVisor where installed | `sandbox/src/` |
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

## Engineering planner and LLM output

The planner (Phase 7) is planning only: it never executes repository code or commands, installs packages, writes files
or touches git. Its boundaries, in detail in [engineering-agent.md](engineering-agent.md#security-boundaries):

- **What reaches the LLM:** the task, constraints and a bounded evidence bundle from the index (paths, symbol and route
  names, one-line summaries, finding rule ids and titles). Never file contents, finding evidence snippets or `.env`
  values; secret files appear only as paths. With `AI_PROVIDER=baseline` nothing leaves the server.
- **Model output is untrusted input:** it is parsed with the plan schema (else rejected), every repository reference is
  checked against the index (nonexistent files and symbols are flagged and marked UNKNOWN; absolute, `~`, drive-letter,
  backslash and `..` paths are removed), VERIFIED claims without valid evidence are downgraded, credential-looking values
  are redacted and text containing shell commands is replaced before anything is stored or shown. The UI renders plan text
  as text.
- **Credentials:** `ANTHROPIC_API_KEY` is read from the environment only, passed to the SDK, and never stored, logged or
  returned; provider errors are mapped to fixed messages. Logs carry provider, model, duration, token counts and
  validation results, never the task, prompt or plan.
- **Prompt injection:** repository text reaches the model only as identifiers and indexer-written summaries. A hostile
  repository can still pick misleading names; the effect is limited to a plan that validation confines to existing files
  and symbols and that nothing executes.

## Authentication

- Passwords: argon2id (19 MiB, t=2), never stored or logged in plain text.
- Sessions: 256-bit random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production). The database
  stores only `HMAC-SHA256(JWT_SECRET, token)`, so a database leak does not yield usable sessions.
- Login does a dummy argon2 verification for unknown emails so timing does not reveal registered accounts.
- CSRF: `SameSite=Lax` plus an `Origin` check on every mutating API request.

## Authorization

Every analysis lookup goes through `getOwnedAnalysis(userId, id)`, which filters by the repository owner and returns
404 (not 403) for other users' analyses so ids cannot be probed. Engineering tasks are looked up by id, owner and the
owner of their analysis's repository, with the same 404 behaviour.

## Rate limiting

`rate-limiter-flexible` backed by Redis (in-memory fallback): login (per IP and per email), signup, analysis, upload,
AI (engineering task creation and plan requests, 30 per user per hour), engine (code-engine runs started and test runs approved,
10 per user per hour) and later report generation.

## HTTP hardening

CSP, `X-Frame-Options: DENY`, `nosniff`, strict referrer policy, permissions policy, HSTS in production,
`X-Powered-By` removed. Errors use a uniform envelope and never include stack traces; each response carries
`X-Request-Id`.

## Known limitations

- Planner shell-command detection is pattern-based; it removes text that looks like a command, and a cleverly phrased
  command in prose could pass. Nothing executes plan text, so this affects only what a reader sees.
- **Docker access is root-equivalent on the Docker host.** With `SANDBOX_ENABLED=true` the worker drives the Docker CLI, and anything that can talk to the Docker daemon can control the host. Run the worker on a dedicated host or VM, prefer rootless Docker, and use `SANDBOX_RUNTIME=runsc` (gVisor) where available. Container isolation with the default runtime (runc) shares the host kernel; a kernel vulnerability could allow an escape.
- The install step has unrestricted outbound network access (not limited to the package registry); install scripts are disabled, but the network itself is not filtered. Keep `SANDBOX_INSTALL_ENABLED=false` unless that is acceptable.
- CSP allows `'unsafe-inline'` scripts because Next.js injects inline bootstrap scripts; nonce-based CSP is planned.
- The analysis clone is bounded by depth and timeout but not by bytes (the code engine's single-commit fetch has a byte limit; applying it to the analysis clone is planned).
- Nested `.gitignore` files are not yet honoured by the scanner (only the root one).
- Private-registry detection for the OSV.dev lookup cannot cover PyPI, Maven or Go, nor npm registries configured
  outside the repository (see above); use `OSV_ENABLED=false` for such code.
- The API checks (`api/unauthenticated-mutation`, `api/missing-input-validation`) only see authentication and validation
  declared in the repository's own source; protection added by a gateway or a wrapper defined elsewhere is not recognised,
  so these findings are reported as LOW and say what was not seen.
- Vulnerability results are only as complete as OSV.dev and the lockfile: packages without an exact version are listed as
  "not checked", and a listed advisory means the version is affected, not that the vulnerable code is reachable.
