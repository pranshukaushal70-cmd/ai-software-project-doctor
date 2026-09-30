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

Worker: RUNNING → CLONING → SCANNING → … → COMPLETED | FAILED
UI:     polls GET /api/analysis/:id every 2 s, renders stage progress, then the results
```

Using the analysis id as the BullMQ `jobId` makes enqueueing idempotent. The worker deletes partial `File` rows
before starting, so a retried job cannot duplicate data.

## Workspaces

| Package | Depends on | Notes |
|---|---|---|
| `@pd/shared` | zod, pino | `constants` subpath is browser-safe; `logger` is server-only |
| `@pd/analyzer` | shared, yauzl, ignore | ingest (`clone`, `zip`, `workspace`), `scanner` |
| `@pd/db` | Prisma 7 + `@prisma/adapter-pg` | generated client in `src/generated` (gitignored) |
| `@pd/worker` | analyzer, db, shared, bullmq | `pipeline.ts` orchestrates stages |
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
| imports / exports | module specifiers and exported names, stored per file for the Phase 4 dependency graph |
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
- passwords embedded in connection strings (`postgres://user:pass@host`), LOW when the host is local;
- values assigned to credential-like names (`password`, `secret`, `token`, `api_key`, `client_secret`, …) in code, JSON,
  YAML, `.properties`, INI/TOML and `.env` files, excluding placeholders (`changeme`, `${VAR}`, `process.env…`,
  `<your-key>`, UPPER_CASE names, labels with spaces, i18n keys, ternaries, and similar);
- committed (non-template) `.env` files that assign values.

Secret values never leave the scanner: evidence shows the line with the value replaced by a mask that keeps at most a
public identifying prefix (e.g. `ghp_…[redacted]`), and fingerprints are derived from the variable name or rule label,
not from the value (a hash of a weak password could be brute-forced). Matches in test and documentation files are one
severity level lower and say why. Templates (`.env.example`) only report real token formats.

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

## Data model

See `packages/db/prisma/schema.prisma`. Results hang off `Analysis` and cascade on delete:
`File`, `Finding`, `Metric`, `Dependency`, `ArchitectureNode`/`ArchitectureEdge`, `GitInsight`, `Recommendation`,
`Report`. Phase 1 populates `Analysis.summary` and `File`; Phase 2 adds file metrics, `Finding` and `Metric`; Phase 3 adds
`SECRET`/`SECURITY` findings and `summary.security` (no schema change: the categories already existed); later phases fill the rest.
