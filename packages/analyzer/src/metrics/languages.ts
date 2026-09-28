import type { AnalyzedLanguage } from "../scanner/languages";

/**
 * Per-language description of the tree-sitter grammar: which node types are
 * functions, classes, decisions, nesting constructs, blocks, and so on.
 * Everything language-specific in the metrics engine lives here.
 */
export interface LanguageSpec {
  /** Grammar id used to load the .wasm file (see parser.ts). */
  grammar: GrammarId;
  functions: ReadonlySet<string>;
  classes: ReadonlySet<string>;
  /**
   * Leaf tokens that add a path to cyclomatic complexity (if, for, while,
   * case, catch, &&, ||, …). Counting tokens instead of nodes handles
   * else-if chains, do-while and comprehensions uniformly.
   */
  decisionTokens: ReadonlyMap<string, DecisionKind>;
  /** Node types that add a decision (for constructs without a unique token, e.g. ternaries). */
  decisionNodes: ReadonlyMap<string, DecisionKind>;
  /** Control-flow constructs that increase nesting depth. */
  nesting: ReadonlySet<string>;
  /** Statement containers checked for unreachable code. */
  blocks: ReadonlySet<string>;
  /** Statements after which the rest of the block cannot execute. */
  terminators: ReadonlySet<string>;
  /** Statements that may legitimately follow a terminator (hoisted declarations, labels, …). */
  unreachableExempt: ReadonlySet<string>;
  /** catch/except clauses checked for empty bodies. */
  catchClauses: ReadonlySet<string>;
  /** Import/include nodes; their tokens are excluded from duplication and reference counting. */
  imports: ReadonlySet<string>;
  comments: ReadonlySet<string>;
  /** Identifier leaf types used for reference counting (unused imports / private members). */
  identifiers: ReadonlySet<string>;
}

export type GrammarId = "javascript" | "typescript" | "tsx" | "python" | "java" | "c" | "cpp";

export type DecisionKind = "if" | "loop" | "case" | "catch" | "logical" | "ternary";

const set = (...items: string[]) => new Set(items);

const C_LIKE_LOGICAL: Array<[string, DecisionKind]> = [
  ["&&", "logical"],
  ["||", "logical"],
];

const JS_BASE = {
  functions: set(
    "function_declaration",
    "generator_function_declaration",
    "function_expression",
    "function",
    "generator_function",
    "arrow_function",
    "method_definition",
  ),
  classes: set("class_declaration", "class", "abstract_class_declaration"),
  decisionTokens: new Map<string, DecisionKind>([
    ["if", "if"],
    ["for", "loop"],
    ["while", "loop"],
    ["case", "case"],
    ["catch", "catch"],
    ...C_LIKE_LOGICAL,
    ["??", "logical"],
  ]),
  decisionNodes: new Map<string, DecisionKind>([["ternary_expression", "ternary"]]),
  nesting: set("if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_statement", "try_statement", "with_statement"),
  blocks: set("statement_block", "switch_case", "switch_default"),
  terminators: set("return_statement", "throw_statement", "break_statement", "continue_statement"),
  unreachableExempt: set(
    "function_declaration",
    "generator_function_declaration",
    "break_statement",
    "empty_statement",
    "comment",
    "html_comment",
    "interface_declaration",
    "type_alias_declaration",
    "ambient_declaration",
  ),
  catchClauses: set("catch_clause"),
  imports: set("import_statement"),
  comments: set("comment", "html_comment"),
  identifiers: set("identifier", "type_identifier", "shorthand_property_identifier"),
} satisfies Omit<LanguageSpec, "grammar">;

const PYTHON: Omit<LanguageSpec, "grammar"> = {
  functions: set("function_definition"),
  classes: set("class_definition"),
  decisionTokens: new Map<string, DecisionKind>([
    ["if", "if"],
    ["elif", "if"],
    ["for", "loop"],
    ["while", "loop"],
    ["case", "case"],
    ["except", "catch"],
    ["and", "logical"],
    ["or", "logical"],
  ]),
  decisionNodes: new Map(),
  nesting: set("if_statement", "for_statement", "while_statement", "try_statement", "with_statement", "match_statement"),
  blocks: set("block"),
  terminators: set("return_statement", "raise_statement", "break_statement", "continue_statement"),
  unreachableExempt: set("pass_statement", "comment"),
  catchClauses: set("except_clause"),
  imports: set("import_statement", "import_from_statement", "future_import_statement"),
  comments: set("comment"),
  identifiers: set("identifier"),
};

const JAVA: Omit<LanguageSpec, "grammar"> = {
  functions: set("method_declaration", "constructor_declaration", "compact_constructor_declaration"),
  classes: set("class_declaration", "interface_declaration", "enum_declaration", "record_declaration"),
  decisionTokens: new Map<string, DecisionKind>([
    ["if", "if"],
    ["for", "loop"],
    ["while", "loop"],
    ["case", "case"],
    ["catch", "catch"],
    ...C_LIKE_LOGICAL,
  ]),
  decisionNodes: new Map<string, DecisionKind>([["ternary_expression", "ternary"]]),
  nesting: set(
    "if_statement",
    "for_statement",
    "enhanced_for_statement",
    "while_statement",
    "do_statement",
    "switch_expression",
    "try_statement",
    "try_with_resources_statement",
    "synchronized_statement",
  ),
  blocks: set("block", "constructor_body", "switch_block_statement_group"),
  terminators: set("return_statement", "throw_statement", "break_statement", "continue_statement", "yield_statement"),
  unreachableExempt: set("break_statement", "line_comment", "block_comment", "switch_label"),
  catchClauses: set("catch_clause"),
  imports: set("import_declaration", "package_declaration"),
  comments: set("line_comment", "block_comment"),
  identifiers: set("identifier", "type_identifier"),
};

const C_BASE = {
  functions: set("function_definition"),
  decisionNodes: new Map<string, DecisionKind>([["conditional_expression", "ternary"]]),
  blocks: set("compound_statement", "case_statement"),
  unreachableExempt: set("labeled_statement", "case_statement", "break_statement", "comment"),
  imports: set("preproc_include"),
  comments: set("comment"),
  identifiers: set("identifier", "type_identifier", "field_identifier"),
};

const C: Omit<LanguageSpec, "grammar"> = {
  ...C_BASE,
  /** C has no classes; struct/union definitions are counted as its composite types. */
  classes: set("struct_specifier", "union_specifier"),
  decisionTokens: new Map<string, DecisionKind>([
    ["if", "if"],
    ["for", "loop"],
    ["while", "loop"],
    ["case", "case"],
    ...C_LIKE_LOGICAL,
  ]),
  nesting: set("if_statement", "for_statement", "while_statement", "do_statement", "switch_statement"),
  terminators: set("return_statement", "break_statement", "continue_statement", "goto_statement"),
  catchClauses: set(),
};

const CPP: Omit<LanguageSpec, "grammar"> = {
  ...C_BASE,
  classes: set("class_specifier", "struct_specifier", "union_specifier"),
  decisionTokens: new Map<string, DecisionKind>([
    ["if", "if"],
    ["for", "loop"],
    ["while", "loop"],
    ["case", "case"],
    ["catch", "catch"],
    ...C_LIKE_LOGICAL,
    ["and", "logical"],
    ["or", "logical"],
  ]),
  nesting: set("if_statement", "for_statement", "for_range_loop", "while_statement", "do_statement", "switch_statement", "try_statement"),
  terminators: set("return_statement", "break_statement", "continue_statement", "goto_statement", "throw_statement", "co_return_statement"),
  catchClauses: set("catch_clause"),
};

const SPECS: Record<GrammarId, LanguageSpec> = {
  javascript: { grammar: "javascript", ...JS_BASE },
  typescript: { grammar: "typescript", ...JS_BASE },
  tsx: { grammar: "tsx", ...JS_BASE },
  python: { grammar: "python", ...PYTHON },
  java: { grammar: "java", ...JAVA },
  c: { grammar: "c", ...C },
  cpp: { grammar: "cpp", ...CPP },
};

/** Pick the grammar for a file. TSX needs its own grammar; `.h` is parsed as C first. */
export function grammarFor(language: AnalyzedLanguage, relPath: string): GrammarId {
  if (language === "typescript") return /\.tsx$/i.test(relPath) ? "tsx" : "typescript";
  return language;
}

export function specFor(grammar: GrammarId): LanguageSpec {
  return SPECS[grammar];
}
