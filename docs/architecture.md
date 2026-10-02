# Architecture

## Principles

1. **Deterministic first.** Anything that can be measured is measured by code, not inferred by an LLM.
2. **Evidence everywhere.** Every detection carries the file/key it came from (`Detection.evidence`), and every
   finding (from Phase 2 on) stores redacted evidence and a stable fingerprint.
3. **Untrusted input.** Repositories are never executed. See [security.md](security.md).
4. **Reproducible.** Each `Analysis` row stores `analyzerVersion` and `commitSha`; scoring weights will be stored
   alongside the score.
5. **Pure engine.** `packages/analyzer` has no database or HTTP dependencies, so it can be unit-tested and run
   from a CLI for the evaluation benchmark.

## Request flow

```text
POST /api/analysis ──► validate (zod + URL allowlist) ──► Repository + Analysis rows (QUEUED)
        │                                                        │
        └──► 202 { analysisId, status: "queued" }                └──► BullMQ job (jobId = analysisId)

Worker: RUNNING → CLONING → SCANNING → PARSING → SECURITY → DEPENDENCIES → ARCHITECTURE → COMPLETED | FAILED
UI:     polls GET /api/analysis/:id every 2 s, renders stage progress, then the results
```

Using the analysis id as the BullMQ `jobId` makes enqueueing idempotent. Before starting, the worker deletes the rows a
previous partial attempt may have left (`ArchitectureEdge`, `ArchitectureNode`, `Dependency`, `Finding`, `Metric`,
`File`), so a retried job cannot duplicate data. Later stages (`GIT`, `AI`, `REPORT`) exist in the schema but do not
run yet; `summary.modulesRun` lists what actually ran.

## Workspaces

| Package | Depends on | Notes |
|---|---|---|
| `@pd/shared` | zod, pino | `constants` subpath is browser-safe; `logger` is server-only |
| `@pd/analyzer` | shared, yauzl, ignore, web-tree-sitter | ingest (`clone`, `zip`, `workspace`), `scanner`; subpaths `metrics`, `security`, `dependencies`, `architecture` |
| `@pd/db` | Prisma 7 + `@prisma/adapter-pg` | generated client in `src/generated` (gitignored) |
| `@pd/worker` | analyzer, db, shared, bullmq | `pipeline.ts` orchestrates stages; `persist.ts` maps analyzer output to rows; supplies `fetch` for OSV.dev |
| `@pd/web` | analyzer, db, shared, bullmq | route handlers are thin; logic lives in `server/services` |

Packages are consumed as TypeScript source (`exports` → `src/index.ts`), transpiled by Next.js
(`transpilePackages`) and by `tsx` in the worker, so there is no separate build step.

## Repository scanner (Phase 1)

`scanRepository(root)` walks the tree without following symlinks, prunes default-ignored directories
(`node_modules`, `dist`, `.git`, `venv`, `target`, …) and honours the root `.gitignore`. For each file it records
the language (by extension or file name), kind (`SOURCE`, `TEST`, `DOCUMENTATION`, `CONFIG`, `GENERATED`, `BINARY`,
`OTHER`) and physical line count. It then detects:

- package managers and build systems (lockfiles and manifests)
- frameworks and libraries (parsed from `package.json`, `requirements*.txt`, `pyproject.toml` (PEP 621 and Poetry),
  `Pipfile`, `pom.xml`, `build.gradle`)
- CI/CD, containers, `.env` files (distinguishing templates), documentation files, entry points

## Code metrics & static analysis (Phase 2)

`@pd/analyzer/metrics` (a separate subpath so the web bundle never loads the parser) parses JavaScript, TypeScript/TSX,
Python, Java, C and C++ with **tree-sitter compiled to WebAssembly** (`web-tree-sitter` + the grammars' own `.wasm`
builds). Parsing untrusted code therefore never touches native code, and each file has a parse time budget (default 5 s).
`.h` files are parsed as C and fall back to C++ when only the C++ grammar parses them cleanly. Minified files are skipped.

One cursor-based pass per file (no recursion, so deeply nested input cannot overflow the stack) computes:

| Metric | Definition |
|---|---|
| lines / loc / commentLines / blankLines | physical lines; lines with a code token; comment-only lines (Python docstrings count as comments); whitespace-only lines. They always sum to `lines`. |
| lloc | logical lines: statement, declaration and definition nodes |
| functions / classes | function, method and lambda-style function nodes; classes, interfaces, enums, records (C: struct/union definitions) |
| cyclomatic complexity | 1 + decision tokens (`if`, `elif`, loops, `case`, `catch`/`except`, `&&`, `||`, `??`, `and`, `or`, ternaries). Nested functions are measured separately. |
| nesting depth | control-flow constructs inside a function; `else if` chains stay at one level |
| imports / exports | module specifiers and exported names, stored per file; the Phase 4 import graph is built from them. Python `from . import a, b` is recorded as `.a`, `.b` (the bare `.` would point every such import at `__init__.py`) |
| duplication | exact clones (whitespace/comments ignored) of ≥ 50 tokens and ≥ 6 lines across production files, via a verified rolling hash |

Rules (`packages/analyzer/src/metrics/rules.ts`, limits stored in `summary.codeMetrics.thresholds`): high complexity, deep
nesting, long function, long parameter list, large file, god class, empty catch, bare `except:`, `debugger`, TODO/FIXME,
duplicate block, and dead-code indicators that are reliable without whole-program analysis: unreachable statements after
return/throw/break/continue, unused imports (JS/TS/Python/Java; names mentioned in comments, `__all__`, string annotations,
`# noqa` and JSX's implicit `React` are exempt), unused private Java methods, and unreferenced `static` C/C++ functions.

Findings are produced for production source only (test files are measured, not flagged). Each finding stores rule id,
type, severity, file, line range, evidence (redacted of credential-like literals), impact, recommendation, structured
`data`, analyzer id + version, and a fingerprint of (rule, path, stable key such as the function name), so a finding keeps its
identity when code moves. At most 5,000 findings are stored per analysis (most severe first); totals are kept in the summary.

The worker runs this in the `PARSING` stage and stores per-file metrics on `File`, findings on `Finding`, repository
aggregates on `Metric` (`fileId = null`), and `summary.codeMetrics` (totals, per-language stats, hotspots, parser versions).

## Security analysis (Phase 3)

`@pd/analyzer/security` has two parts, both deterministic:

**Secret detection** (`security/secrets.ts`) searches every text file (source, tests, config, docs, `.env`; not binaries,
generated files or oversized files) line by line for:

- well-known credential formats: PEM private keys (only when key material follows the header), AWS access key IDs and
  secret keys, Google API keys, GitHub/GitLab/Slack/Stripe/OpenAI/Anthropic/npm/SendGrid tokens, Slack webhooks, JWTs;
- passwords embedded in connection strings (`postgres://user:<password>@host`), LOW when the host is local;
- values assigned to credential-like names (`password`, `secret`, `token`, `api_key`, `client_secret`, …) in code, JSON,
  YAML, `.properties`, INI/TOML and `.env` files, excluding placeholders (`changeme`, `${VAR}`, `process.env…`,
  `<your-key>`, UPPER_CASE names, labels with spaces, i18n keys, ternaries, and similar);
- committed (non-template) `.env` files that assign values.

Secret values never leave the scanner: evidence shows the line with the value replaced by a mask that keeps at most a
public identifying prefix (e.g. `ghp_…[redacted]`), and fingerprints are derived from the variable name or rule label,
not from the value (a hash of a weak password could be brute-forced). Every secret finding records its file context
(`source`, `configuration`, `template`, `test`, `documentation`; generated files are not scanned). In tests and docs,
arbitrary passwords and connection strings are reported as INFO and marked likely intentional, while real provider
token formats are only one level lower and ask for verification; see [security.md](security.md#secret-findings-context-and-triage).
Templates (`.env.example`) only report real token formats.

**Insecure-pattern detection** (`security/patterns.ts`) inspects the tree-sitter trees of production source through the
`onTree` hook of `analyzeCode`, so each file is parsed once. Rules match the syntactic shape of a dangerous call, with
"dynamic" meaning "not a constant literal":

| Rule | Examples |
|---|---|
| `injection/dynamic-code-execution` (CWE-95) | `eval(x)`, `new Function(x)`, `setTimeout("…" + x)`, Python `eval`/`exec` |
| `injection/os-command` (CWE-78) | `child_process.exec(\`…${x}\`)`, `spawn(…, { shell: true })`, `os.system(x)`, `subprocess.run(…, shell=True)`, `Runtime.exec(x)`, C `system(x)` |
| `injection/sql` (CWE-89) | SQL text built with `+`, template literals, f-strings, `%`, `.format` or `String.format` and passed to `query`/`execute`/`executeQuery`/… (tagged templates such as Prisma's `$queryRaw\`\`` are safe) |
| `injection/xss-sink` (CWE-79) | `innerHTML`/`outerHTML` assignment, `document.write`, `insertAdjacentHTML`, `dangerouslySetInnerHTML` with a dynamic value |
| `unsafe/deserialization` (CWE-502) | `pickle.loads`, `yaml.load` without a safe Loader, `ObjectInputStream`, `XMLDecoder` |
| `crypto/tls-verification-disabled` (CWE-295) | `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `verify=False`, `ssl.CERT_NONE`, `NoopHostnameVerifier`, `CURLOPT_SSL_VERIFYPEER 0` |
| `crypto/jwt-verification-disabled` (CWE-347) | `algorithms: ['none']`, `jwt.decode(…, verify=False)`, `verify_signature: False` |
| `crypto/weak-hash` (CWE-328) | MD5/SHA-1 via `createHash`, `hashlib` (unless `usedforsecurity=False`), `MessageDigest`, OpenSSL |
| `crypto/weak-cipher` (CWE-327) | `createCipher`, DES/RC4/Blowfish, ECB mode, Java `Cipher.getInstance("AES")` |
| `crypto/insecure-randomness` (CWE-338) | `Math.random()`/`random.*`/`java.util.Random` assigned to a token/secret/password/nonce/salt name |
| `memory/unsafe-c-function` (CWE-120) | `gets`, `strcpy`, `strcat`, `sprintf`, `scanf("%s")` |
| `config/debug-mode` (CWE-489) | Flask `app.run(debug=True)`, Django `DEBUG = True` in a settings module |

There is no data-flow analysis, so a flagged call may be safe when its input is trusted; the evidence says what was
matched so a reviewer can judge. Each finding stores `data.cwe` and `data.owasp`. The worker runs this in the `SECURITY`
stage, stores findings (category `SECRET` or `SECURITY`, analyzer `security`) next to the code-quality findings,
`security.*` rows on `Metric`, and `summary.security` (totals, per-rule counts, most affected files, committed env files).
At most 2,000 security findings are stored (most severe first).

## Dependency analysis (Phase 4)

`@pd/analyzer/dependencies` reads manifests and lockfiles as data (nothing is installed or executed):

| Ecosystem | Manifests | Lockfiles (exact versions, transitive packages) |
|---|---|---|
| npm | `package.json` (dependencies, optional, peer, dev) | `package-lock.json` / `npm-shrinkwrap.json` v1–3, `yarn.lock` (classic and Berry), `pnpm-lock.yaml` v5–9, `bun.lock`; `bun.lockb` is binary: recognised (no "missing lockfile") but not read |
| PyPI | `requirements*.txt`, `pyproject.toml` (PEP 621, PEP 735 groups, Poetry, uv), `Pipfile` | `poetry.lock`, `uv.lock`, `pdm.lock`, `Pipfile.lock` |
| Maven | `pom.xml` (`${properties}`, `dependencyManagement`; parent POMs are not fetched), `build.gradle(.kts)` string notation | none (exact versions come from the manifest) |
| Go | `go.mod` (`// indirect` = transitive; local `replace` = path dependency) | none (`go.mod` versions are exact) |
| Cargo | `Cargo.toml` (incl. `[dependencies.x]` tables, renames, target-specific tables) | `Cargo.lock` |

Each manifest is paired with the nearest lockfile in its directory or a parent (monorepos and workspaces), and
workspace-internal packages are recognised and excluded from registry checks. Every dependency records whether it is
**direct** (declared in a manifest) or **transitive** (only in a lockfile), dev-only, its declared spec and resolved
version, the manifest or lockfile it comes from, and its source (`registry`, `git`, `url`, `path`, `workspace`). The
analyzer does not reconstruct which package requires which; the relationship stored is direct vs transitive and where it
is declared or locked.

**Vulnerabilities.** Exact registry versions are looked up on OSV.dev ([security.md](security.md#outbound-network-osvdev)
explains what is sent and how private packages are handled). Severity comes from the CVSS v3 base score computed from the
advisory's vector, else from the advisory database's own rating, else MEDIUM; dev-only packages are rated one level
lower. The suggested fix is the lowest version that fixes every advisory affecting the installed version (none when an
advisory has no fix).

| Rule | Severity |
|---|---|
| `dependency/known-vulnerability` | from the advisories (see above) |
| `dependency/missing-lockfile` | MEDIUM with runtime dependencies, LOW for dev-only or a `Pipfile` |
| `dependency/unpinned-version` (`*`, `latest`, empty, Maven `LATEST`/`1.+`) | LOW, INFO for dev |
| `dependency/non-registry-source` (git or URL) | LOW |
| `dependency/unused-candidate` (npm runtime dependency that no JS/TS file of the package imports and that package scripts and config files do not mention) | INFO |

The worker runs this in the `DEPENDENCIES` stage and stores one `Dependency` row per package (with `vulnIds` and
`dataSource`), `DEPENDENCY` findings, `dependencies.*` metrics and `summary.dependencies` (totals, per-ecosystem counts,
manifests, lookup status, and the 100 most severe vulnerable packages with advisory details). `Dependency` has no
columns for the declaration line or source, so the line is only kept where a finding refers to the dependency.

## Architecture analysis (Phase 4)

`@pd/analyzer/architecture` builds the import graph of production source files (tests, generated code and assets are
not nodes) from the imports recorded by the code-metrics pass. Resolution is static and conservative, linking an import
only when the language's lookup rules point at exactly one file:

- **JavaScript/TypeScript:** relative paths with extension and `index` lookup, `.js` specifiers that refer to `.ts`
  sources, `tsconfig`/`jsconfig` `paths` and `baseUrl` (following relative `extends`), and workspace packages through
  `package.json` `exports`/`main`. Node built-ins and third-party packages are counted separately.
- **Python:** relative imports and absolute imports from detected package roots (`src/` and the parents of top-level
  packages); standard-library modules are recognised.
- **Java:** class, nested-class, static and wildcard imports by package path.
- **C/C++:** `#include` next to the file, from the root, from `include`/`inc`/`src` directories, or by a unique path suffix.

On the file graph it finds **import cycles** (Tarjan's strongly connected components; each is reported with its shortest
loop), computes fan-in/fan-out, and groups files into **modules** by directory, choosing the deepest level (≤ 8) that
gives at most 30 modules. Each module gets fan-in, fan-out and instability = fan-out ÷ (fan-in + fan-out). **Layers**
(interface → service → data → shared) are inferred from directory and file names and checked only when at least two are
present.

| Rule | Severity |
|---|---|
| `architecture/circular-dependency` | MEDIUM when JavaScript, TypeScript or Python is involved (cycles cause partially initialised modules at runtime), LOW for compiled languages; one level higher at ≥ 10 files |
| `architecture/layer-violation` (a lower layer imports a higher one) | LOW |
| `architecture/high-fan-out` (> 20 internal files imported; barrel files such as `index.ts` exempt) | LOW, MEDIUM above 40 |

The worker runs this in the `ARCHITECTURE` stage and stores `ArchitectureNode` rows (`FILE` and `MODULE`, at most
10,000 file nodes, the most connected first) with their metrics, `ArchitectureEdge` rows (`import` between files,
`module` between modules, with weight and `inCycle`), `ARCHITECTURE` findings, `architecture.*` metrics and
`summary.architecture` (totals, modules, module edges, cycles, hubs, layers, top external packages, resolution info).

## Web API and UI (Phase 4)

`GET /api/analysis/:id/dependencies` and `GET /api/analysis/:id/architecture` ([api.md](api.md)) follow the findings
route: authenticated, ownership-checked through `getOwnedAnalysis`, zod-validated queries
(`dependenciesQuerySchema`/`architectureQuerySchema` in `@pd/shared`), with the query logic in
`web/server/services/{dependency,architecture}-service.ts`.

The analysis page has **Dependencies** and **Architecture** tabs:

- *Dependencies*: lookup status (explains partial, failed, disabled and skipped lookups instead of showing zero
  vulnerabilities), headline counts, vulnerable packages with relationship, fixed version and advisory links,
  ecosystems, manifests and lockfiles, a filterable and paginated table of every dependency (direct/transitive, dev,
  ecosystem, vulnerable only, name search), and dependency findings.
- *Architecture*: headline counts, import cycles shown as paths, an SVG import graph (module view, or file view filtered
  by module or to cycle members; layered left to right by longest import chain, cycle edges highlighted, at most 60
  modules or 80 files with a note when truncated), a module table with instability, most imported and most importing
  files, layers, top external packages, and architecture findings.

Analyses made by earlier analyzer versions show a notice in these tabs instead of empty results.

## Data model

See `packages/db/prisma/schema.prisma`. Results hang off `Analysis` and cascade on delete:
`File`, `Finding`, `Metric`, `Dependency`, `ArchitectureNode`/`ArchitectureEdge`, `GitInsight`, `Recommendation`,
`Report`. Phase 1 populates `Analysis.summary` and `File`; Phase 2 adds file metrics, `Finding` and `Metric`; Phase 3 adds
`SECRET`/`SECURITY` findings and `summary.security`; Phase 4 fills `Dependency`, `ArchitectureNode` and `ArchitectureEdge`
and adds `DEPENDENCY`/`ARCHITECTURE` findings and `summary.dependencies`/`summary.architecture`. Phases 3 and 4 needed no
schema change: the tables, categories and stages already existed. `FindingTriage` (migration `20261002120000_finding_triage`)
stores Expected/Ignored decisions per repository and finding fingerprint; it is the only table that outlives an
analysis's findings, and it is deleted with its repository. Later phases fill the rest.
