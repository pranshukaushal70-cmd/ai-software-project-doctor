# Demo project

`storefront/` is a small, **deliberately flawed** Express + Prisma web shop. Signed-in users can analyse it from
**New analysis → Try the demo project** (or `POST /api/analysis/demo`) to see every Project Doctor module produce
results without uploading their own code. It is never run, built or installed.

The flaws are intentional and documented here so the demo's results can be checked:

| Area | Planted issue | Where |
|---|---|---|
| Security | Hard-coded admin password, SQL built by string concatenation, MD5 password hashing | `src/config.js`, `src/db.js`, `src/auth.js` |
| Dependencies | Outdated `lodash`, `express` and `jsonwebtoken` with known advisories (looked up on OSV.dev when enabled) | `package.json.demo`, `package-lock.json.demo` |
| Architecture | Import cycle between orders and pricing | `src/orders.js`, `src/pricing.js` |
| Code quality | One very complex discount function | `src/pricing.js` |
| API | CORS reflecting any origin with credentials, unauthenticated `DELETE`, request body used without validation, stack traces returned to clients, login without rate limiting | `src/server.js` |
| Database | Foreign keys without an index, no migrations | `prisma/schema.prisma` |
| Testing | Few tests, one skipped test, no CI | `tests/` |
| Documentation | Thin README with a broken link, no license, undocumented environment variables | `README.md`, `src/config.js` |

The secret is a made-up value, not a real credential.

`package.json` and `package-lock.json` are stored as `*.demo` so that GitHub's dependency graph and Dependabot do not
raise alerts for the intentionally outdated packages in this repository. The worker copies the project into the
analysis workspace and restores the original file names there.
