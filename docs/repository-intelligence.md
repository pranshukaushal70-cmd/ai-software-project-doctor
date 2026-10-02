# Repository intelligence (Phase 6)

The repository intelligence layer turns a repository into a structured, queryable representation: a manifest of what the
repository is made of, a symbol index, a resolved file-dependency graph, call references, and deterministic queries over
them (impact analysis, related tests, keyword search). It is the foundation later AI agents will use instead of raw
repository dumps: an agent asks a structured question and receives bounded, structured context.

It does **not** modify code, run code, install anything or call an LLM. Autonomous editing, sandboxes and agents are later
phases.

## Pipeline

```text
ingest (hardened clone / safe ZIP / demo copy)
  → scan (walk, classify, hash)                       packages/analyzer/src/scanner
  → parse once with tree-sitter ──► code metrics       packages/analyzer/src/metrics
                                 ├─► security patterns packages/analyzer/src/security
                                 └─► symbols, imports, call sites   intelligence/symbols.ts
  → … dependencies, architecture, practices, health score (Phases 4–5)
  → INDEXING: manifest, import resolution, call resolution, modules, ranking   intelligence/index.ts
  → persisted: File (contentHash), FileDependency, CodeSymbol, SymbolReference, summary.intelligence
  → queried: RepositoryGraph (intelligence/graph.ts) behind /api/analysis/:id/{manifest,modules,symbols,references,imports,impact,context}
```

| Requirement | Where it lives |
|---|---|
| Ingestion: walk the tree, `.gitignore`, ignored directories (`node_modules`, `.next`, `build`, `dist`, caches …), no symlinks, binary sniffing, size limit, file-count cap | Existing scanner (`scanner/walker.ts`, `ingest/ignore-rules.ts`), reused unchanged; now also stores a SHA-256 `contentHash` per readable file |
| File roles: source, test, manifest, lockfile, config, infrastructure, documentation, generated, binary, secret, other | `intelligence/roles.ts` (path-based) |
| Manifest: name, languages, frameworks, test frameworks, package managers, build systems, runtime versions, manifests, lockfiles, Docker, CI/CD, infrastructure, entry points, source/test directories, docs, config, secret files | `intelligence/manifest.ts` |
| Code structure: functions, classes, methods, interfaces, types, enums, constants, exports, imports, call sites | `intelligence/symbols.ts` (TypeScript, JavaScript, Python) |
| Routes and API handlers | Phase 5 API analyzer (`practices/api.ts`), linked into impact results |
| Dependency graph: internal / external / builtin / unresolved imports, cycles, ranking | `intelligence/index.ts` with the Phase 4 resolver (`architecture/resolve.ts`) and Tarjan SCC (`architecture/graph.ts`) |
| Symbol index and queries | `CodeSymbol`, `SymbolReference`, `RepositoryGraph` |
| Impact analysis | `RepositoryGraph.impact` |

## Deterministic vs. heuristic

Everything in this layer is **deterministic**: the same repository content gives the same rows, the same ranking and the
same query answers (stable sort orders, fixed iteration counts, no randomness, no network, no LLM). Some results are
deterministic *approximations*, and the API says so:

| Exact (as precise as the syntax) | Approximate (documented on each result) |
|---|---|
| Declarations and their line ranges, export flags, import bindings | Call targets: linked only when unambiguous (a function imported by name, a default import, `ns.fn()` on an imported namespace/module, a local declaration, a unique `this`/`self` method). Other calls are kept **by name** (`resolved: false`) when the name is defined somewhere in the repository |
| Import resolution by each language's lookup rules (same resolver as the architecture graph) | Related tests: tests that import the target (distance given) **or** are named after it (`reason: "name"`) |
| Graph traversal (BFS distances), cycles (Tarjan), PageRank | Related configuration: nearest manifest/lockfile above the file and config files in the same directory (path-based; configuration contents are not inspected) |
| File roles and manifest entries, each with its evidence | Keyword search: lexical matching of words and stems in symbol names, paths and routes; not semantic understanding |

What it cannot see: types (so `obj.method()` on an object of an inferred type is not linked), dynamic imports and
computed module names, reflection and dependency injection, code generated at build time, and languages other than
TypeScript, JavaScript and Python for symbols (their files and imports are still indexed).

**No vector search.** Every question in scope ("where is X defined", "who imports Y", "who calls Z", "what is affected")
has an exact or bounded structural answer. Embeddings would add a model, an index to keep in sync and non-determinism
without improving those answers. Keyword search covers locating a feature by name; semantic search can be added later as
a separate layer over the same symbols if an agent needs it.

## Data model

Results hang off `Analysis` (one immutable snapshot of one commit) and cascade on delete. Repository-scoped tables would
need versioning to stay consistent with an analysis; analysis-scoped rows give agents a consistent snapshot for free.

| Model | Purpose | Indexes |
|---|---|---|
| `File.contentHash` | SHA-256 of the file bytes (text files within the size limit). Unchanged files have the same hash across analyses, the basis for future incremental indexing and caching | — |
| `CodeSymbol` | One declaration: name, kind (`SymbolKind`), parent class/function, exported, default export, line range, redacted signature, stable `key` | `(analysisId, key)` unique, `(analysisId, name)`, `(fileId)` |
| `SymbolReference` | One call site: file, enclosing symbol, called name, receiver, line, `targetSymbolId` when resolved | `(analysisId, name)`, `(targetSymbolId)`, `(fromSymbolId)`, `(fileId)` |
| `FileDependency` | One import of a source/test file: specifier, kind (`DependencyKind`: `INTERNAL`, `EXTERNAL`, `BUILTIN`, `UNRESOLVED`), target file or package | `(fromFileId)`, `(toFileId)`, `(analysisId, kind)` |
| `Analysis.summary.intelligence` | Manifest, totals, modules, top files, cycles, external packages, unresolved imports, truncation flags | — |

`ArchitectureEdge` (Phase 4) is kept as it is: it holds the source-only, aggregated graph used for drawing. `FileDependency`
is the complete record (tests included, unresolved and external imports included) used for queries. The repository
`Repository` and analysis `Analysis` models already existed; no `RepositoryFile`/`RepositoryAnalysis` duplicates were added.

Migration: `20261004120000_repository_intelligence` (two enums, the `INDEXING` stage, `File.contentHash`, three tables).

## Limits (per analysis)

| What | Limit | When exceeded |
|---|---|---|
| Files scanned | 50,000 (scanner) | `summary.ignored.truncated` |
| Symbols per file / calls per file | 2,000 / 5,000 | `truncated.filesWithTooManySymbols` |
| Symbols / references / file dependencies | 100,000 / 200,000 / 200,000 | `truncated.symbols` / `.references` / `.dependencies` |
| Impact result lists | 500 entries per list, depth ≤ 20 (default 10) | `impact.truncated` |
| Symbol and reference pages | ≤ 200 per page | paginated |

## Performance

- **One parse per file.** Symbols are extracted in the `onTree` hook of the existing metrics pass; the tree is walked with
  a cursor (no recursion, no full node materialisation).
- **Sequential, bounded I/O.** The scanner already reads files one at a time; the manifest reads only a short list of small
  files (≤ 64 KB), the resolver configuration files ≤ 512 KB. No file contents are stored.
- **Calls are filtered at index time.** Calls of library code (receiver or name bound to an external import) and of names
  defined nowhere in the repository are not stored, which keeps `SymbolReference` proportional to repository code.
- **Batched inserts** (1,000 rows) and key → id mapping after insert, as for the architecture graph.
- **Query graph cache.** Completed analyses never change, so the web tier keeps the in-memory `RepositoryGraph` of the four
  most recently used analyses (ids, paths and names only). List endpoints (`symbols`, `references`, `imports`) query the
  database directly through the indexes above.
- **Deterministic hashing** (`contentHash`) identifies unchanged files across analyses. Re-using a previous analysis's rows
  for unchanged files (incremental indexing) is not implemented yet.

## Agent interface

`POST /api/analysis/:id/context` takes one structured operation and returns bounded, structured results. Agents get
the latest analysis of a repository from `GET /api/repositories`.

```json
{ "operation": "search", "query": "find authentication implementation" }
→ { "hits": [{ "type": "symbol", "name": "authenticateUser", "path": "src/auth/authenticate.ts", "line": 6, "score": 6.75, "detail": "function" }, …] }

{ "operation": "impact_analysis", "target": "src/auth/authenticate.ts" }
→ { "target": { "type": "file", "found": true, … }, "directDependents": […], "transitiveDependents": [{ "path": …, "depth": 1 }, …],
    "relatedTests": […], "relatedRoutes": […], "relatedConfig": […], "affectedModules": […], "graph": { "nodes": …, "edges": … } }
```

| Operation | Answers |
|---|---|
| `manifest` | What the repository is made of |
| `search` (`query`, `limit`) | Where a feature is implemented (symbols, files, routes by keyword) |
| `find_symbol` (`name`, `path?`) | Where a symbol is defined |
| `find_references` (`name`, `path?`) | Who calls it (resolved and name-only call sites) |
| `file_imports` / `file_importers` (`path`) | What a file imports / which files import it |
| `related_tests` (`path`) | Which tests cover a file |
| `find_route` (`query`) | Where an API route is implemented |
| `impact_analysis` (`target`, `type?`, `path?`, `depth?`) | What is affected if a file, symbol or module changes; `type` is inferred when omitted |

## Security

The layer inherits the ingest guarantees (no execution, no hooks, safe ZIP extraction, no symlinks, size limits) and adds:

- Contents of secret files (`.env` and variants other than templates, `.npmrc`, `.pypirc`, `.netrc`, private keys,
  keystores) are never read by the manifest or resolver; they are listed by path only.
- Version strings read from repository files are accepted only if they match `^[\w.+*^~<>=!, |-]{1,40}$`.
- Signatures pass through the same secret redaction as finding evidence; no file contents are stored.
- Query paths must be repository-relative (no leading `/`, no `\`, no NUL, no `..`) and are only matched against stored
  rows, never opened on disk.
- Every endpoint requires a session and checks ownership (`getOwnedAnalysis`, 404 for others); `POST /context` also
  requires a same-origin `Origin` header. Results are bounded (see Limits).
