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

## Data model

See `packages/db/prisma/schema.prisma`. Results hang off `Analysis` and cascade on delete:
`File`, `Finding`, `Metric`, `Dependency`, `ArchitectureNode`/`ArchitectureEdge`, `GitInsight`, `Recommendation`,
`Report`. Phase 1 populates `Analysis.summary` and `File`; Phase 2 adds file metrics, `Finding` and `Metric`; later phases fill the rest.
