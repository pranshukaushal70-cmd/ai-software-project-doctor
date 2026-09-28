import type { Node, Tree } from "web-tree-sitter";
import type { Severity } from "@pd/shared/constants";
import { plural, snippet } from "./evidence";
import type { DecisionKind, GrammarId, LanguageSpec } from "./languages";
import {
  CODE_THRESHOLDS,
  complexitySeverity,
  fileSizeSeverity,
  functionLengthSeverity,
  nestingSeverity,
  parameterSeverity,
  type RuleKey,
} from "./rules";

// ---------------------------------------------------------------- public types

export interface FunctionMetrics {
  name: string;
  isMethod: boolean;
  line: number;
  endLine: number;
  codeLines: number;
  complexity: number;
  decisions: Partial<Record<DecisionKind, number>>;
  maxNesting: number;
  parameters: number;
}

export interface ClassMetrics {
  name: string;
  line: number;
  endLine: number;
  methods: number;
  codeLines: number;
}

export interface FileMetrics {
  /** Physical lines. */
  lines: number;
  /** Lines containing code (cloc "code"). */
  codeLines: number;
  /** Lines containing only comments (docstrings count as comments). */
  commentLines: number;
  blankLines: number;
  /** Logical lines: statement and declaration nodes. */
  logicalLines: number;
  functionCount: number;
  classCount: number;
  maxComplexity: number;
  avgComplexity: number;
  maxNesting: number;
  /** ERROR/MISSING nodes produced by the parser's error recovery. */
  parseErrors: number;
  imports: string[];
  exports: string[];
  functions: FunctionMetrics[];
  classes: ClassMetrics[];
}

/** A finding before it is attached to a path and fingerprinted. */
export interface RawFinding {
  rule: RuleKey;
  severity: Severity;
  line: number;
  endLine: number;
  evidence: string;
  /** Stable identity within the file (e.g. function name), used for the fingerprint instead of line numbers. */
  key: string;
  data?: Record<string, unknown>;
}

/** Normalised token stream for duplicate detection (comments and imports removed). */
export interface TokenStream {
  hashes: Int32Array;
  rows: Int32Array;
}

export interface FileAnalysis {
  metrics: FileMetrics;
  findings: RawFinding[];
  tokens: TokenStream;
}

export interface AnalyzeTreeOptions {
  path: string;
  /** Findings are only produced for production source (not tests). */
  emitFindings: boolean;
  /** Collect the token stream for duplicate detection. */
  collectTokens: boolean;
}

// ---------------------------------------------------------------- internal state

const CODE = 1;
const COMMENT = 2;

const SKIP = 1 << 0;
const POP_FUNCTION = 1 << 1;
const POP_CLASS = 1 << 2;
const POP_NESTING = 1 << 3;
const LEAVE_IMPORT = 1 << 4;

const MAX_IMPORTS = 500;
const MAX_EXPORTS = 200;
const MAX_TODOS_PER_FILE = 20;

interface FunctionFrame {
  kind: "function";
  name: string;
  isMethod: boolean;
  startRow: number;
  endRow: number;
  decisions: Partial<Record<DecisionKind, number>>;
  depth: number;
  maxDepth: number;
  path: string[];
  deepestPath: string[];
  deepestRow: number;
  parameters: string[];
  topLevel: boolean;
}

interface ClassFrame {
  kind: "class";
  name: string;
  startRow: number;
  endRow: number;
  methods: number;
}

interface ModuleFrame {
  kind: "module";
  decisions: Partial<Record<DecisionKind, number>>;
  depth: number;
  path: string[];
}

type Frame = FunctionFrame | ClassFrame | ModuleFrame;

interface ImportBinding {
  name: string;
  row: number;
  statement: string;
}

const NESTING_LABELS: Record<string, string> = {
  if_statement: "if",
  for_statement: "for",
  for_in_statement: "for",
  enhanced_for_statement: "for",
  for_range_loop: "for",
  while_statement: "while",
  do_statement: "do-while",
  switch_statement: "switch",
  switch_expression: "switch",
  match_statement: "match",
  try_statement: "try",
  try_with_resources_statement: "try",
  with_statement: "with",
  synchronized_statement: "synchronized",
};

const DECISION_LABELS: Record<DecisionKind, string> = {
  if: "if/else-if",
  loop: "loop",
  case: "case",
  catch: "catch/except",
  logical: "&&/||",
  ternary: "ternary",
};

/** Statement-level nodes that only wrap another statement or a list of them. */
const LOGICAL_EXCLUDED = new Set([
  "statement_block",
  "compound_statement",
  "export_statement",
  "labeled_statement",
  "decorated_definition",
  "template_declaration",
  "empty_statement",
  "expression_statement_list",
]);

function isLogicalStatement(type: string): boolean {
  if (LOGICAL_EXCLUDED.has(type) || type.includes("parameter")) return false;
  return type === "declaration" || type.endsWith("_statement") || type.endsWith("_declaration") || type.endsWith("_definition");
}

/** FNV-1a hash of a token's text. */
function hashToken(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

function countPhysicalLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

const unquote = (s: string) => s.replace(/^[`'"]+|[`'"]+$/g, "");
const TODO_RE = /\b(TODO|FIXME|HACK|XXX)\b/;

// ---------------------------------------------------------------- analyzer

/**
 * Single-pass analysis of a parsed file. Walks the tree with a cursor (no
 * recursion, so deeply nested input cannot overflow the stack) and computes
 * line classes, functions, classes, complexity, nesting, imports/exports and
 * rule findings.
 */
export function analyzeTree(tree: Tree, source: string, spec: LanguageSpec, opts: AnalyzeTreeOptions): FileAnalysis {
  const g: GrammarId = spec.grammar;
  const isJs = g === "javascript" || g === "typescript" || g === "tsx";
  const isC = g === "c" || g === "cpp";
  const lineCount = countPhysicalLines(source);
  const rowFlags = new Uint8Array(lineCount + 1);
  const sourceLines = source.split("\n");
  const lineText = (row: number) => sourceLines[row] ?? "";

  const findings: RawFinding[] = [];
  const functions: FunctionMetrics[] = [];
  const classes: ClassMetrics[] = [];
  const imports: string[] = [];
  const exports: string[] = [];
  const importBindings: ImportBinding[] = [];
  const refCounts = new Map<string, number>();
  const commentTexts: string[] = [];
  const stringTexts: string[] = [];
  const noqaRows = new Set<number>();
  const privateMethods: Array<{ name: string; row: number; endRow: number }> = [];
  const invokedNames = new Set<string>();
  const staticFunctions: Array<{ name: string; row: number; endRow: number }> = [];
  const declaratorStarts = new Set<number>();
  const macroBodies: string[] = [];
  const pyAll = new Set<string>();
  let hasPyAll = false;
  const topLevelPublic: string[] = [];
  const docstringStarts = new Set<number>();
  let hasJsx = false;
  let parseErrors = 0;
  let logicalLines = 0;
  let todoCount = 0;

  const tokenHashes: number[] = [];
  const tokenRows: number[] = [];

  const moduleFrame: ModuleFrame = { kind: "module", decisions: {}, depth: 0, path: [] };
  const frames: Frame[] = [moduleFrame];
  const ancestors: string[] = [];
  let importDepth = 0;

  const currentCode = (): FunctionFrame | ModuleFrame => {
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i]!;
      if (f.kind !== "class") return f;
    }
    return moduleFrame;
  };
  const enclosingClass = (): ClassFrame | null => {
    const top = frames[frames.length - 1]!;
    return top.kind === "class" ? top : null;
  };
  const insideFunction = () => frames.some((f) => f.kind === "function");
  const insideClass = () => frames.some((f) => f.kind === "class");
  const qualifiedName = (name: string) => {
    const parts = frames.filter((f): f is FunctionFrame | ClassFrame => f.kind !== "module").map((f) => f.name);
    return [...parts, name].join(".");
  };
  const countCodeRows = (start: number, end: number) => {
    let n = 0;
    for (let r = start; r <= end && r < lineCount; r++) if (rowFlags[r]! & CODE) n++;
    return n;
  };
  const endRowOf = (pos: { row: number; column: number }, startRow: number) =>
    pos.column === 0 && pos.row > startRow ? pos.row - 1 : pos.row;

  const addFinding = (f: RawFinding) => {
    if (opts.emitFindings) findings.push(f);
  };

  // ------------------------------------------------------------ names & parameters

  function functionName(node: Node): string {
    const named = node.childForFieldName("name");
    if (named) return named.text;
    if (isC) {
      const decl = findFunctionDeclarator(node);
      const id = decl?.childForFieldName("declarator");
      if (id) return id.text;
    }
    const parent = node.parent;
    if (parent) {
      switch (parent.type) {
        case "variable_declarator":
          return parent.childForFieldName("name")?.text ?? "<anonymous>";
        case "assignment_expression":
          return parent.childForFieldName("left")?.text ?? "<anonymous>";
        case "pair":
          return unquote(parent.childForFieldName("key")?.text ?? "<anonymous>");
        case "public_field_definition":
        case "field_definition":
          return (parent.childForFieldName("name") ?? parent.childForFieldName("property"))?.text ?? "<anonymous>";
        case "type_definition":
          return parent.childForFieldName("declarator")?.text ?? "<anonymous>";
      }
    }
    return "<anonymous>";
  }

  function findFunctionDeclarator(node: Node): Node | null {
    let d: Node | null = node.childForFieldName("declarator");
    while (d && d.type !== "function_declarator") d = d.childForFieldName("declarator");
    return d;
  }

  function parameterNames(node: Node, isMethod: boolean): string[] {
    if (isJs && node.type === "arrow_function") {
      const single = node.childForFieldName("parameter");
      if (single) return [single.text];
    }
    const list = isC ? findFunctionDeclarator(node)?.childForFieldName("parameters") : node.childForFieldName("parameters");
    if (!list) return [];
    let params = list.namedChildren.filter((c): c is Node => c !== null && !spec.comments.has(c.type));
    if (g === "java") params = params.filter((p) => p.type !== "receiver_parameter");
    if (isC && params.length === 1 && params[0]!.type === "parameter_declaration" && params[0]!.text.trim() === "void") return [];
    if (g === "python") {
      params = params.filter((p) => p.type !== "keyword_separator" && p.type !== "positional_separator");
      if (isMethod && params[0] && /^(self|cls)$/.test(params[0].text)) params = params.slice(1);
    }
    return params.map((p) => snippet(p.text, 40));
  }

  // ------------------------------------------------------------ language-specific extraction

  function recordImport(spec: string) {
    if (imports.length < MAX_IMPORTS && spec) imports.push(spec);
  }
  function recordExport(name: string) {
    if (exports.length < MAX_EXPORTS && name) exports.push(name);
  }

  function handleJsImport(node: Node) {
    const source = node.childForFieldName("source");
    if (source) recordImport(unquote(source.text));
    const statement = snippet(node.text);
    const row = node.startPosition.row;
    for (const clause of node.namedChildren) {
      if (clause?.type !== "import_clause") continue;
      for (const part of clause.namedChildren) {
        if (!part) continue;
        if (part.type === "identifier") importBindings.push({ name: part.text, row, statement });
        else if (part.type === "namespace_import") {
          const id = part.namedChildren.find((c) => c?.type === "identifier");
          if (id) importBindings.push({ name: id.text, row, statement });
        } else if (part.type === "named_imports") {
          for (const spec of part.namedChildren) {
            if (spec?.type !== "import_specifier") continue;
            const local = spec.childForFieldName("alias") ?? spec.childForFieldName("name");
            if (local) importBindings.push({ name: local.text, row, statement });
          }
        }
      }
    }
  }

  function handleJsExport(node: Node) {
    const decl = node.childForFieldName("declaration");
    if (node.children.some((c) => c?.type === "default")) recordExport("default");
    if (decl) {
      const name = decl.childForFieldName("name");
      if (name) recordExport(name.text);
      else for (const d of decl.namedChildren) if (d?.type === "variable_declarator") recordExport(d.childForFieldName("name")?.text ?? "");
    }
    const clause = node.namedChildren.find((c) => c?.type === "export_clause");
    if (clause) {
      for (const s of clause.namedChildren) {
        if (s?.type === "export_specifier") recordExport((s.childForFieldName("alias") ?? s.childForFieldName("name"))?.text ?? "");
      }
    }
    const source = node.childForFieldName("source");
    if (source) {
      recordImport(unquote(source.text));
      if (!clause) recordExport(`* from ${unquote(source.text)}`);
    }
  }

  function handleJsCall(node: Node) {
    const fn = node.childForFieldName("function");
    if (!fn || !(fn.type === "import" || (fn.type === "identifier" && fn.text === "require"))) return;
    const arg = node.childForFieldName("arguments")?.namedChildren[0];
    if (arg?.type === "string") recordImport(unquote(arg.text));
  }

  function handlePythonImport(node: Node) {
    const statement = snippet(node.text);
    const row = node.startPosition.row;
    if (node.type === "future_import_statement") return;
    if (node.type === "import_statement") {
      for (const c of node.namedChildren) {
        if (c?.type === "dotted_name") {
          recordImport(c.text);
          importBindings.push({ name: c.text.split(".")[0]!, row, statement });
        } else if (c?.type === "aliased_import") {
          recordImport(c.childForFieldName("name")?.text ?? "");
          const alias = c.childForFieldName("alias");
          if (alias) importBindings.push({ name: alias.text, row, statement });
        }
      }
      return;
    }
    // import_from_statement
    const moduleName = node.childForFieldName("module_name");
    if (moduleName) recordImport(moduleName.text);
    if (moduleName?.text === "__future__") return;
    for (const c of node.childrenForFieldName("name")) {
      if (c.type === "dotted_name") importBindings.push({ name: c.text, row, statement });
      else if (c.type === "aliased_import") {
        const alias = c.childForFieldName("alias");
        if (alias) importBindings.push({ name: alias.text, row, statement });
      }
    }
  }

  function handleJavaImport(node: Node) {
    if (node.type !== "import_declaration") return;
    const text = node.text.replace(/^import\s+(static\s+)?/, "").replace(/;\s*$/, "").trim();
    recordImport(text);
    if (!text.endsWith("*")) {
      importBindings.push({ name: text.slice(text.lastIndexOf(".") + 1), row: node.startPosition.row, statement: snippet(node.text) });
    }
  }

  function handleCInclude(node: Node) {
    const p = node.childForFieldName("path");
    if (p) recordImport(p.text.replace(/^[<"]|[>"]$/g, ""));
  }

  function hasModifier(node: Node, modifier: string): boolean {
    if (g === "java") {
      const mods = node.namedChildren.find((c) => c?.type === "modifiers");
      return !!mods && mods.children.some((c) => c?.type === modifier);
    }
    return node.namedChildren.some((c) => c?.type === "storage_class_specifier" && c.text === modifier);
  }

  // ------------------------------------------------------------ rule checks on specific nodes

  function checkUnreachable(node: Node) {
    if (node.hasError) return;
    const value = node.childForFieldName("value");
    const statements = node.namedChildren.filter(
      (c): c is Node =>
        c !== null && !spec.comments.has(c.type) && c.type !== "switch_label" && !(value && c.startIndex === value.startIndex),
    );
    const termIndex = statements.findIndex((s) => spec.terminators.has(s.type));
    if (termIndex < 0) return;
    const dead = statements.slice(termIndex + 1).find((s) => !spec.unreachableExempt.has(s.type) && !s.type.startsWith("preproc_"));
    if (!dead) return;
    const term = statements[termIndex]!;
    const last = statements[statements.length - 1]!;
    const deadRow = dead.startPosition.row;
    addFinding({
      rule: "unreachable",
      severity: "MEDIUM",
      line: deadRow + 1,
      endLine: last.endPosition.row + 1,
      evidence: `\`${snippet(dead.text, 80)}\` at line ${deadRow + 1} follows \`${snippet(term.text, 60)}\` at line ${term.startPosition.row + 1} in the same block and can never execute.`,
      key: `unreachable:${qualifiedName("")}:${snippet(dead.text, 60)}`,
    });
  }

  function checkCatch(node: Node) {
    const row = node.startPosition.row;
    if (g === "python") {
      const block = node.namedChildren.find((c) => c?.type === "block");
      const clauseArgs = node.namedChildren.filter((c) => c && c.type !== "block" && c.type !== "comment");
      if (clauseArgs.length === 0) {
        addFinding({
          rule: "bareExcept",
          severity: "MEDIUM",
          line: row + 1,
          endLine: node.endPosition.row + 1,
          evidence: `\`${snippet(lineText(row))}\` at line ${row + 1} catches every exception, including KeyboardInterrupt and SystemExit.`,
          key: `bare-except:${qualifiedName("")}`,
        });
      }
      const onlyPass =
        block &&
        block.namedChildren.every(
          (s) => s?.type === "pass_statement" || (s?.type === "expression_statement" && s.text.trim() === "..."),
        );
      if (onlyPass && node.descendantsOfType("comment").length === 0) {
        addFinding({
          rule: "emptyCatch",
          severity: "MEDIUM",
          line: row + 1,
          endLine: node.endPosition.row + 1,
          evidence: `\`${snippet(lineText(row))}\` at line ${row + 1} only contains \`pass\`; the exception is discarded without handling or logging.`,
          key: `empty-catch:${qualifiedName("")}`,
        });
      }
      return;
    }
    const body = node.childForFieldName("body");
    if (body && body.namedChildCount === 0) {
      addFinding({
        rule: "emptyCatch",
        severity: "MEDIUM",
        line: row + 1,
        endLine: node.endPosition.row + 1,
        evidence: `\`${snippet(node.text, 100)}\` at line ${row + 1} has an empty body and no comment; the exception is discarded.`,
        key: `empty-catch:${qualifiedName("")}`,
      });
    }
  }

  function markPythonDocstring(container: Node) {
    const first = container.namedChildren.find((c) => c && c.type !== "comment");
    if (first?.type === "expression_statement" && first.namedChildCount === 1) {
      const t = first.namedChildren[0]?.type;
      if (t === "string" || t === "concatenated_string") docstringStarts.add(first.startIndex);
    }
  }

  // ------------------------------------------------------------ frames

  function pushFunction(node: Node) {
    const cls = enclosingClass();
    const isMethod = cls !== null;
    if (cls) cls.methods++;
    const name = functionName(node);
    const startRow = node.startPosition.row;
    const topLevel = !insideFunction() && !insideClass();
    frames.push({
      kind: "function",
      name,
      isMethod,
      startRow,
      endRow: endRowOf(node.endPosition, startRow),
      decisions: {},
      depth: 0,
      maxDepth: 0,
      path: [],
      deepestPath: [],
      deepestRow: startRow,
      parameters: parameterNames(node, isMethod),
      topLevel,
    });

    if (g === "java" && node.type === "method_declaration" && hasModifier(node, "private")) {
      privateMethods.push({ name, row: startRow, endRow: node.endPosition.row });
    }
    if (isC && topLevel) {
      const declarator = findFunctionDeclarator(node)?.childForFieldName("declarator");
      if (declarator) declaratorStarts.add(declarator.startIndex);
      if (hasModifier(node, "static")) staticFunctions.push({ name, row: startRow, endRow: node.endPosition.row });
      else recordExport(name);
    }
    if (g === "python" && topLevel && !name.startsWith("_")) topLevelPublic.push(name);
  }

  function popFunction() {
    const f = frames.pop() as FunctionFrame;
    const decisionCount = Object.values(f.decisions).reduce((a, b) => a + b, 0);
    const complexity = 1 + decisionCount;
    const codeLines = countCodeRows(f.startRow, f.endRow);
    const qualified = qualifiedName(f.name);
    functions.push({
      name: qualified,
      isMethod: f.isMethod,
      line: f.startRow + 1,
      endLine: f.endRow + 1,
      codeLines,
      complexity,
      decisions: f.decisions,
      maxNesting: f.maxDepth,
      parameters: f.parameters.length,
    });

    const where = `\`${qualified}\` (lines ${f.startRow + 1}–${f.endRow + 1})`;
    const complexitySev = complexitySeverity(complexity);
    if (complexitySev) {
      const breakdown = (Object.entries(f.decisions) as Array<[DecisionKind, number]>)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n} ${DECISION_LABELS[k]}`)
        .join(", ");
      addFinding({
        rule: "complexity",
        severity: complexitySev,
        line: f.startRow + 1,
        endLine: f.endRow + 1,
        evidence: `Function ${where} has cyclomatic complexity ${complexity} (limit ${CODE_THRESHOLDS.complexity.medium}). Decision points: ${breakdown}.`,
        key: `fn:${qualified}`,
        data: { complexity, limit: CODE_THRESHOLDS.complexity.medium, decisions: f.decisions },
      });
    }
    const nestingSev = nestingSeverity(f.maxDepth);
    if (nestingSev) {
      addFinding({
        rule: "nesting",
        severity: nestingSev,
        line: f.deepestRow + 1,
        endLine: f.deepestRow + 1,
        evidence: `Function ${where} reaches nesting depth ${f.maxDepth} at line ${f.deepestRow + 1} (limit ${CODE_THRESHOLDS.nesting.medium}): ${f.deepestPath.join(" → ")}.`,
        key: `fn:${qualified}`,
        data: { depth: f.maxDepth, limit: CODE_THRESHOLDS.nesting.medium, path: f.deepestPath },
      });
    }
    const lengthSev = functionLengthSeverity(codeLines);
    if (lengthSev) {
      addFinding({
        rule: "longFunction",
        severity: lengthSev,
        line: f.startRow + 1,
        endLine: f.endRow + 1,
        evidence: `Function ${where} has ${codeLines} lines of code (limit ${CODE_THRESHOLDS.functionCodeLines.medium}).`,
        key: `fn:${qualified}`,
        data: { codeLines, limit: CODE_THRESHOLDS.functionCodeLines.medium },
      });
    }
    const paramSev = parameterSeverity(f.parameters.length);
    if (paramSev) {
      addFinding({
        rule: "longParameterList",
        severity: paramSev,
        line: f.startRow + 1,
        endLine: f.startRow + 1,
        evidence: `Function ${where} declares ${f.parameters.length} parameters (limit ${CODE_THRESHOLDS.parameters.low}): ${f.parameters.slice(0, 12).join(", ")}${f.parameters.length > 12 ? ", …" : ""}.`,
        key: `fn:${qualified}`,
        data: { parameters: f.parameters.length, limit: CODE_THRESHOLDS.parameters.low },
      });
    }
  }

  function isClassDefinition(node: Node): boolean {
    // C/C++ struct_specifier also appears in plain type references (`struct foo *p`).
    return !isC || node.childForFieldName("body") !== null;
  }

  function pushClass(node: Node) {
    const startRow = node.startPosition.row;
    const found = functionName(node);
    const name = found === "<anonymous>" ? `<anonymous ${node.type.replace(/_(declaration|specifier|definition)$/, "")}>` : found;
    const topLevel = !insideFunction() && !insideClass();
    frames.push({ kind: "class", name, startRow, endRow: endRowOf(node.endPosition, startRow), methods: 0 });
    if (topLevel) {
      if (g === "python" && !name.startsWith("_")) topLevelPublic.push(name);
      if (g === "java" && hasModifier(node, "public")) recordExport(name);
    }
  }

  function popClass() {
    const c = frames.pop() as ClassFrame;
    const codeLines = countCodeRows(c.startRow, c.endRow);
    const qualified = qualifiedName(c.name);
    classes.push({ name: qualified, line: c.startRow + 1, endLine: c.endRow + 1, methods: c.methods, codeLines });
    if (c.methods > CODE_THRESHOLDS.classMethods || codeLines > CODE_THRESHOLDS.classCodeLines) {
      addFinding({
        rule: "godClass",
        severity: "MEDIUM",
        line: c.startRow + 1,
        endLine: c.endRow + 1,
        evidence: `Class \`${qualified}\` (lines ${c.startRow + 1}–${c.endRow + 1}) has ${plural(c.methods, "method")} and ${codeLines} lines of code (limits: ${CODE_THRESHOLDS.classMethods} methods / ${CODE_THRESHOLDS.classCodeLines} lines).`,
        key: `class:${qualified}`,
        data: { methods: c.methods, codeLines },
      });
    }
  }

  // ------------------------------------------------------------ walk

  const cursor = tree.walk();

  function enter(): number {
    const type = cursor.nodeType;
    if (type === "ERROR" || cursor.nodeIsMissing) parseErrors++;
    // Keywords are anonymous leaves whose type can equal a node type ("class", "function").
    if (!cursor.nodeIsNamed) return 0;

    if (spec.comments.has(type)) {
      const start = cursor.startPosition.row;
      const end = endRowOf(cursor.endPosition, start);
      for (let r = start; r <= end; r++) rowFlags[r]! |= COMMENT;
      const text = source.slice(cursor.startIndex, cursor.endIndex);
      commentTexts.push(text);
      if (g === "python" && /noqa/i.test(text)) noqaRows.add(start);
      const m = TODO_RE.exec(text);
      if (m && todoCount < MAX_TODOS_PER_FILE) {
        const offsetRow = start + (text.slice(0, m.index).match(/\n/g)?.length ?? 0);
        todoCount++;
        addFinding({
          rule: "todo",
          severity: "INFO",
          line: offsetRow + 1,
          endLine: offsetRow + 1,
          evidence: `\`${snippet(lineText(offsetRow))}\` at line ${offsetRow + 1}.`,
          key: `todo:${snippet(lineText(offsetRow), 80)}`,
        });
      }
      return SKIP;
    }

    // Python docstrings are documentation, not code.
    if (type === "expression_statement" && docstringStarts.has(cursor.startIndex)) {
      const start = cursor.startPosition.row;
      const end = endRowOf(cursor.endPosition, start);
      for (let r = start; r <= end; r++) rowFlags[r]! |= COMMENT;
      return SKIP;
    }

    if (isLogicalStatement(type)) logicalLines++;
    let flags = 0;

    if (spec.imports.has(type)) {
      const node = cursor.currentNode;
      if (isJs) handleJsImport(node);
      else if (g === "python") handlePythonImport(node);
      else if (g === "java") handleJavaImport(node);
      else handleCInclude(node);
      importDepth++;
      flags |= LEAVE_IMPORT;
    }

    if (spec.functions.has(type)) {
      pushFunction(cursor.currentNode);
      flags |= POP_FUNCTION;
    } else if (spec.classes.has(type)) {
      const node = cursor.currentNode;
      if (isClassDefinition(node)) {
        pushClass(node);
        flags |= POP_CLASS;
      }
    }

    const decision = spec.decisionNodes.get(type);
    if (decision) {
      const f = currentCode();
      f.decisions[decision] = (f.decisions[decision] ?? 0) + 1;
    }

    if (spec.nesting.has(type)) {
      const parent = ancestors[ancestors.length - 1];
      const elseIf =
        type === "if_statement" && (parent === "else_clause" || (parent === "if_statement" && cursor.currentFieldName === "alternative"));
      if (!elseIf) {
        const f = currentCode();
        f.depth++;
        f.path.push(NESTING_LABELS[type] ?? type);
        if (f.kind === "function" && f.depth > f.maxDepth) {
          f.maxDepth = f.depth;
          f.deepestPath = [...f.path];
          f.deepestRow = cursor.startPosition.row;
        }
        flags |= POP_NESTING;
      }
    }

    if (spec.blocks.has(type)) checkUnreachable(cursor.currentNode);
    if (spec.catchClauses.has(type)) checkCatch(cursor.currentNode);

    if (g === "python" && (type === "module" || (type === "block" && /^(function|class)_definition$/.test(ancestors[ancestors.length - 1] ?? "")))) {
      markPythonDocstring(cursor.currentNode);
    }

    if (isJs) {
      if (type === "export_statement") handleJsExport(cursor.currentNode);
      else if (type === "call_expression") handleJsCall(cursor.currentNode);
      else if (type === "assignment_expression" && !insideFunction()) {
        const node = cursor.currentNode;
        const left = node.childForFieldName("left")?.text ?? "";
        if (left === "module.exports") {
          const right = node.childForFieldName("right");
          if (right?.type === "object") {
            for (const p of right.namedChildren) {
              if (p?.type === "pair") recordExport(unquote(p.childForFieldName("key")?.text ?? ""));
              else if (p?.type === "shorthand_property_identifier" || p?.type === "method_definition") {
                recordExport(p.type === "method_definition" ? (p.childForFieldName("name")?.text ?? "") : p.text);
              }
            }
          } else recordExport("module.exports");
        } else if (/^(module\.)?exports\.\w+$/.test(left)) recordExport(left.slice(left.lastIndexOf(".") + 1));
      } else if (!hasJsx && type.startsWith("jsx_")) hasJsx = true;
      else if (type === "debugger_statement") {
        const row = cursor.startPosition.row;
        addFinding({
          rule: "debugger",
          severity: "LOW",
          line: row + 1,
          endLine: row + 1,
          evidence: `\`debugger\` statement at line ${row + 1}${insideFunction() ? ` in \`${qualifiedName("").replace(/\.$/, "")}\`` : ""}.`,
          key: `debugger:${qualifiedName("")}`,
        });
      }
    } else if (g === "python" && type === "expression_statement" && !insideFunction() && !insideClass()) {
      const node = cursor.currentNode;
      const assign = node.namedChildren[0];
      if (assign?.type === "assignment" && assign.childForFieldName("left")?.text === "__all__") {
        hasPyAll = true;
        for (const s of assign.childForFieldName("right")?.descendantsOfType("string") ?? []) pyAll.add(unquote(s.text));
      }
    } else if (g === "java") {
      if (type === "method_invocation") {
        const name = cursor.currentNode.childForFieldName("name");
        if (name) invokedNames.add(name.text);
      } else if (type === "method_reference") {
        const last = cursor.currentNode.namedChildren.at(-1);
        if (last) invokedNames.add(last.text);
      }
    } else if (isC && type === "declaration") {
      // Prototypes (`static int f(void);`) name a function without referencing it.
      for (const d of cursor.currentNode.descendantsOfType("function_declarator")) {
        const id = d.childForFieldName("declarator");
        if (id) declaratorStarts.add(id.startIndex);
      }
    }

    return flags;
  }

  function leaf() {
    const type = cursor.nodeType;
    const startIndex = cursor.startIndex;
    const endIndex = cursor.endIndex;
    if (endIndex <= startIndex) return; // zero-width MISSING nodes
    const start = cursor.startPosition.row;
    const end = endRowOf(cursor.endPosition, start);
    for (let r = start; r <= end; r++) rowFlags[r]! |= CODE;

    const decision = cursor.nodeIsNamed ? undefined : spec.decisionTokens.get(type);
    if (decision) {
      const f = currentCode();
      f.decisions[decision] = (f.decisions[decision] ?? 0) + 1;
    }
    if (importDepth > 0) return;

    const text = source.slice(startIndex, endIndex);
    if (opts.collectTokens) {
      tokenHashes.push(hashToken(text));
      tokenRows.push(start);
    }
    if (spec.identifiers.has(type) || type === "shorthand_property_identifier_pattern") {
      if (!(isC && declaratorStarts.has(startIndex))) refCounts.set(text, (refCounts.get(text) ?? 0) + 1);
    } else if (g === "python" && type === "string_content") {
      stringTexts.push(text);
    } else if (type === "preproc_arg") {
      macroBodies.push(text);
    }
  }

  function exit(flags: number) {
    if (flags & POP_NESTING) {
      const f = currentCode();
      f.depth--;
      f.path.pop();
    }
    if (flags & POP_FUNCTION) popFunction();
    if (flags & POP_CLASS) popClass();
    if (flags & LEAVE_IMPORT) importDepth--;
  }

  const exits: number[] = [];
  outer: for (;;) {
    const type = cursor.nodeType;
    const flags = enter();
    if (!(flags & SKIP) && cursor.gotoFirstChild()) {
      exits.push(flags);
      ancestors.push(type);
      continue;
    }
    if (!(flags & SKIP)) leaf();
    exit(flags);
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) break outer;
      ancestors.pop();
      exit(exits.pop()!);
    }
  }
  cursor.delete();

  // ------------------------------------------------------------ line classes

  let codeLines = 0;
  let commentLines = 0;
  let blankLines = 0;
  for (let r = 0; r < lineCount; r++) {
    const f = rowFlags[r]!;
    if (f & CODE) codeLines++;
    else if (f & COMMENT) commentLines++;
    else if (lineText(r).trim() === "") blankLines++;
    else codeLines++; // text outside any token (should not happen); count conservatively as code
  }

  // ------------------------------------------------------------ file-level findings

  if (opts.emitFindings) {
    const sizeSev = fileSizeSeverity(codeLines);
    if (sizeSev) {
      findings.push({
        rule: "largeFile",
        severity: sizeSev,
        line: 1,
        endLine: lineCount,
        evidence: `File has ${codeLines} lines of code (limit ${CODE_THRESHOLDS.fileCodeLines.low}) across ${plural(functions.length, "function")} and ${plural(classes.length, "class", "es")}.`,
        key: "file",
        data: { codeLines, limit: CODE_THRESHOLDS.fileCodeLines.low },
      });
    }
    findUnusedImports();
    findUnusedPrivate();
  }

  function findUnusedImports() {
    if (g === "c" || g === "cpp") return;
    if (g === "python" && /(^|\/)__init__\.py$/.test(opts.path)) return; // package re-exports
    const comments = commentTexts.join("\n");
    const strings = g === "python" ? stringTexts.join("\n") : "";
    const jsxPragma = /@jsx\s+(\w+)/.exec(comments)?.[1];
    const seen = new Set<string>();
    for (const b of importBindings) {
      if (seen.has(b.name)) continue;
      seen.add(b.name);
      if ((refCounts.get(b.name) ?? 0) > 0) continue;
      if (hasJsx && (b.name === "React" || b.name === jsxPragma)) continue;
      const word = new RegExp(`\\b${b.name.replace(/[$]/g, "\\$")}\\b`);
      if (word.test(comments)) continue; // e.g. {@link Foo} or type comments
      if (g === "python" && (pyAll.has(b.name) || noqaRows.has(b.row) || word.test(strings))) continue;
      findings.push({
        rule: "unusedImport",
        severity: "LOW",
        line: b.row + 1,
        endLine: b.row + 1,
        evidence: `\`${b.name}\` is imported at line ${b.row + 1} (\`${b.statement}\`) but never referenced in this file.`,
        key: `import:${b.name}`,
      });
    }
  }

  function findUnusedPrivate() {
    for (const m of privateMethods) {
      if (invokedNames.has(m.name.slice(m.name.lastIndexOf(".") + 1))) continue;
      findings.push({
        rule: "unusedPrivate",
        severity: "LOW",
        line: m.row + 1,
        endLine: m.endRow + 1,
        evidence: `Private method \`${m.name}\` declared at line ${m.row + 1} is never called or referenced in this file.`,
        key: `private:${m.name}`,
      });
    }
    const macros = macroBodies.join("\n");
    for (const fn of staticFunctions) {
      if ((refCounts.get(fn.name) ?? 0) > 0) continue;
      if (new RegExp(`\\b${fn.name}\\b`).test(macros)) continue;
      findings.push({
        rule: "unusedPrivate",
        severity: "LOW",
        line: fn.row + 1,
        endLine: fn.endRow + 1,
        evidence: `\`static\` function \`${fn.name}\` defined at line ${fn.row + 1} is never referenced in this translation unit.`,
        key: `static:${fn.name}`,
      });
    }
  }

  if (g === "python") for (const name of hasPyAll ? pyAll : topLevelPublic) recordExport(name);

  const complexities = functions.map((f) => f.complexity);
  const totalComplexity = complexities.reduce((a, b) => a + b, 0);
  return {
    metrics: {
      lines: lineCount,
      codeLines,
      commentLines,
      blankLines,
      logicalLines,
      functionCount: functions.length,
      classCount: classes.length,
      maxComplexity: complexities.length ? Math.max(...complexities) : 0,
      avgComplexity: complexities.length ? Math.round((totalComplexity / complexities.length) * 100) / 100 : 0,
      maxNesting: functions.reduce((m, f) => Math.max(m, f.maxNesting), 0),
      parseErrors,
      imports,
      exports,
      functions,
      classes,
    },
    findings,
    tokens: { hashes: Int32Array.from(tokenHashes), rows: Int32Array.from(tokenRows) },
  };
}
