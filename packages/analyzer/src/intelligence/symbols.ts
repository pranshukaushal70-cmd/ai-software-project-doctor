import type { Node } from "web-tree-sitter";
import { snippet } from "../metrics/evidence";
import type { TreeContext } from "../metrics";

/**
 * Symbol extraction for the repository index. Runs on the syntax trees the
 * code-metrics pass already parses (through `analyzeCode`'s `onTree` hook), so
 * every file is parsed once. TypeScript, JavaScript and Python are covered.
 *
 * Extraction is syntactic and deterministic: declarations, import bindings and
 * call sites as written. No types are inferred, so `obj.save()` is recorded as a
 * call of `save` whose target is only known when the receiver is an imported
 * module or `this`.
 */

export const SYMBOL_KINDS = ["FUNCTION", "CLASS", "METHOD", "INTERFACE", "TYPE", "ENUM", "CONSTANT", "VARIABLE"] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  /** Enclosing class (methods) or function (nested declarations); null at module level. */
  parent: string | null;
  exported: boolean;
  /** This symbol is the module's default export. */
  isDefault: boolean;
  line: number;
  endLine: number;
  /** Declaration head (name and parameters), single line, redacted, truncated. */
  signature: string | null;
}

export interface ImportBinding {
  /** Module specifier as written (`./auth`, `app.models`, `.orders`). */
  specifier: string;
  /** Name in the source module: an export name, `default`, or `*` for a namespace / whole module. */
  imported: string;
  /** Name bound in this file. */
  local: string;
  line: number;
}

export interface CallSite {
  /** Called name: the function, or the method/property for `a.b()`. */
  name: string;
  /** Receiver for member calls (`api` in `api.get()`, `this`); null for plain calls. */
  receiver: string | null;
  /** Index into the file's symbols of the innermost enclosing named function/method/class, or -1 at module level. */
  enclosing: number;
  line: number;
  /** `new X()` rather than a call. */
  construct: boolean;
}

export interface FileSymbols {
  path: string;
  grammar: string;
  symbols: ExtractedSymbol[];
  imports: ImportBinding[];
  calls: CallSite[];
  /** More declarations or calls than the per-file caps; the rest were dropped. */
  truncated: boolean;
}

const MAX_SYMBOLS_PER_FILE = 2000;
const MAX_CALLS_PER_FILE = 5000;
const SIGNATURE_MAX = 120;

const JS_GRAMMARS = new Set(["javascript", "typescript", "tsx"]);
const unquote = (s: string) => s.replace(/^[`'"]+|[`'"]+$/g, "");
const isUpperConstant = (name: string) => /^[A-Z][A-Z0-9_]*$/.test(name) && /[A-Z]/.test(name);

interface Scope {
  /** Index of the symbol that opened the scope, or -1 for an anonymous function. */
  symbol: number;
  kind: "class" | "function";
  name: string | null;
}

/** Extracts symbols, import bindings and call sites from one parsed file; null for unsupported grammars. */
export function extractSymbols(ctx: Pick<TreeContext, "tree" | "source" | "path" | "grammar">): FileSymbols | null {
  const js = JS_GRAMMARS.has(ctx.grammar);
  const py = ctx.grammar === "python";
  if (!js && !py) return null;

  const symbols: ExtractedSymbol[] = [];
  const imports: ImportBinding[] = [];
  const calls: CallSite[] = [];
  const scopes: Scope[] = [];
  /** Names exported by `export { a, b }`, `module.exports = { … }` or `__all__`, applied at the end. */
  const exportedNames = new Set<string>();
  let defaultName: string | null = null;
  let pyAll: Set<string> | null = null;
  let truncated = false;

  const line = (n: Node) => n.startPosition.row + 1;
  const endLine = (n: Node) => n.endPosition.row + 1;
  const enclosingSymbol = () => {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i]!.symbol >= 0) return scopes[i]!.symbol;
    return -1;
  };
  const parentName = () => {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i]!.name) return scopes[i]!.name;
    return null;
  };
  const atModuleLevel = () => scopes.length === 0;

  function add(name: string, kind: SymbolKind, node: Node, opts: { exported?: boolean; isDefault?: boolean; signature?: string | null } = {}): number {
    if (!name) return -1;
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) {
      truncated = true;
      return -1;
    }
    symbols.push({
      name,
      kind,
      parent: parentName(),
      exported: !!opts.exported,
      isDefault: !!opts.isDefault,
      line: line(node),
      endLine: endLine(node),
      signature: opts.signature ?? null,
    });
    return symbols.length - 1;
  }

  function signatureOf(name: string, node: Node): string | null {
    const params = node.childForFieldName("parameters") ?? node.childForFieldName("parameter");
    if (!params) return null;
    const ret = node.childForFieldName("return_type");
    return snippet(`${name}${params.text}${ret ? (py ? ` -> ${ret.text}` : ret.text) : ""}`, SIGNATURE_MAX);
  }

  /** `export …` (JS) directly wraps the declaration. */
  const jsExportOf = (node: Node) => {
    const p = node.parent;
    if (p?.type !== "export_statement") return { exported: false, isDefault: false };
    return { exported: true, isDefault: p.children.some((c) => c?.type === "default") };
  };

  function recordCall(name: string, receiver: string | null, node: Node, construct: boolean) {
    if (!name) return;
    if (calls.length >= MAX_CALLS_PER_FILE) {
      truncated = true;
      return;
    }
    calls.push({ name, receiver, enclosing: enclosingSymbol(), line: line(node), construct });
  }

  // ---------------------------------------------------------------- JavaScript / TypeScript

  /** Returns the scope this node opens, if any. */
  function enterJs(node: Node): Scope | null {
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        const name = node.childForFieldName("name")?.text ?? "";
        const exp = jsExportOf(node);
        const i = add(name, "FUNCTION", node, { ...exp, exported: exp.exported && atModuleLevel(), signature: signatureOf(name, node) });
        if (exp.isDefault) defaultName = name;
        return { symbol: i, kind: "function", name: name || null };
      }
      case "class_declaration":
      case "abstract_class_declaration": {
        const name = node.childForFieldName("name")?.text ?? "";
        const exp = jsExportOf(node);
        const i = add(name, "CLASS", node, { ...exp, exported: exp.exported && atModuleLevel() });
        if (exp.isDefault) defaultName = name;
        return { symbol: i, kind: "class", name: name || null };
      }
      case "method_definition": {
        const name = node.childForFieldName("name")?.text ?? "";
        const i = add(name, "METHOD", node, { signature: signatureOf(name, node) });
        return { symbol: i, kind: "function", name: null };
      }
      case "public_field_definition": {
        const value = node.childForFieldName("value");
        if (value && (value.type === "arrow_function" || value.type === "function_expression" || value.type === "function")) {
          const name = node.childForFieldName("name")?.text ?? "";
          const i = add(name, "METHOD", node, { signature: signatureOf(name, value) });
          return { symbol: i, kind: "function", name: null };
        }
        return null;
      }
      case "interface_declaration":
      case "type_alias_declaration":
      case "enum_declaration": {
        const name = node.childForFieldName("name")?.text ?? "";
        const kind: SymbolKind = node.type === "interface_declaration" ? "INTERFACE" : node.type === "enum_declaration" ? "ENUM" : "TYPE";
        add(name, kind, node, jsExportOf(node));
        return null;
      }
      case "variable_declarator": {
        const declaration = node.parent;
        const statement = declaration?.parent;
        const topLevel = atModuleLevel() && (statement?.type === "program" || statement?.type === "export_statement");
        const nameNode = node.childForFieldName("name");
        const value = node.childForFieldName("value");
        if (value?.type === "call_expression" && isRequire(value)) {
          // `const x = require("y")` is an import binding, not a declaration.
          recordRequire(nameNode, value);
          return null;
        }
        if (!topLevel || nameNode?.type !== "identifier") return null;
        const name = nameNode.text;
        const exported = statement?.type === "export_statement";
        if (value && (value.type === "arrow_function" || value.type === "function_expression" || value.type === "function" || value.type === "generator_function")) {
          const i = add(name, "FUNCTION", node, { exported, signature: signatureOf(name, value) });
          return { symbol: i, kind: "function", name };
        }
        const isConst = declaration?.type === "lexical_declaration" && /^\s*const\b/.test(declaration.text);
        add(name, isConst ? "CONSTANT" : "VARIABLE", node, { exported });
        return null;
      }
      case "arrow_function":
      case "function_expression":
      case "function":
      case "generator_function":
        // Anonymous functions are not symbols, but calls inside them still belong to the enclosing named symbol.
        return { symbol: -1, kind: "function", name: null };
      case "import_statement":
        recordJsImport(node);
        return null;
      case "export_statement":
        recordJsExportClause(node);
        return null;
      case "call_expression": {
        const fn = node.childForFieldName("function");
        if (!fn || isRequire(node) || fn.type === "import") return null;
        if (fn.type === "identifier") recordCall(fn.text, null, node, false);
        else if (fn.type === "member_expression") {
          const prop = fn.childForFieldName("property");
          const obj = fn.childForFieldName("object");
          if (prop) recordCall(prop.text, obj ? snippet(obj.text, 60) : null, node, false);
        }
        return null;
      }
      case "new_expression": {
        const ctor = node.childForFieldName("constructor");
        if (ctor?.type === "identifier") recordCall(ctor.text, null, node, true);
        return null;
      }
      case "assignment_expression":
        recordCommonJsExport(node);
        return null;
      default:
        return null;
    }
  }

  function isRequire(call: Node): boolean {
    const fn = call.childForFieldName("function");
    return fn?.type === "identifier" && fn.text === "require";
  }

  /** `const x = require("y")`, `const { a, b: c } = require("y")`. */
  function recordRequire(nameNode: Node | null, call: Node) {
    const arg = call.childForFieldName("arguments")?.namedChildren[0];
    if (arg?.type !== "string" || !nameNode) return;
    const specifier = unquote(arg.text);
    if (nameNode.type === "identifier") imports.push({ specifier, imported: "*", local: nameNode.text, line: line(call) });
    else if (nameNode.type === "object_pattern") {
      for (const p of nameNode.namedChildren) {
        if (p?.type === "shorthand_property_identifier_pattern") imports.push({ specifier, imported: p.text, local: p.text, line: line(call) });
        else if (p?.type === "pair_pattern") {
          const key = p.childForFieldName("key")?.text;
          const value = p.childForFieldName("value");
          if (key && value?.type === "identifier") imports.push({ specifier, imported: key, local: value.text, line: line(call) });
        }
      }
    }
  }

  function recordJsImport(node: Node) {
    const source = node.childForFieldName("source");
    if (!source) return;
    const specifier = unquote(source.text);
    const at = line(node);
    let bound = false;
    for (const clause of node.namedChildren) {
      if (clause?.type !== "import_clause") continue;
      for (const part of clause.namedChildren) {
        if (!part) continue;
        if (part.type === "identifier") {
          imports.push({ specifier, imported: "default", local: part.text, line: at });
          bound = true;
        } else if (part.type === "namespace_import") {
          const id = part.namedChildren.find((c) => c?.type === "identifier");
          if (id) imports.push({ specifier, imported: "*", local: id.text, line: at });
          bound = true;
        } else if (part.type === "named_imports") {
          for (const s of part.namedChildren) {
            if (s?.type !== "import_specifier") continue;
            const name = s.childForFieldName("name")?.text ?? "";
            const alias = s.childForFieldName("alias")?.text;
            if (name) imports.push({ specifier, imported: name, local: alias ?? name, line: at });
            bound = true;
          }
        }
      }
    }
    // Side-effect import (`import "./polyfills"`): a dependency without bindings.
    if (!bound) imports.push({ specifier, imported: "*", local: "", line: at });
  }

  function recordJsExportClause(node: Node) {
    const clause = node.namedChildren.find((c) => c?.type === "export_clause");
    const source = node.childForFieldName("source");
    if (clause) {
      for (const s of clause.namedChildren) {
        if (s?.type !== "export_specifier") continue;
        const name = s.childForFieldName("name")?.text ?? "";
        const alias = s.childForFieldName("alias")?.text;
        // Re-exports from another module are dependencies of this file; local ones mark symbols exported.
        if (source) imports.push({ specifier: unquote(source.text), imported: name, local: "", line: line(node) });
        else if (alias === "default") defaultName = name;
        else exportedNames.add(name);
      }
    } else if (source) imports.push({ specifier: unquote(source.text), imported: "*", local: "", line: line(node) });
    // `export default someIdentifier;`
    const value = node.childForFieldName("value");
    if (value?.type === "identifier" && node.children.some((c) => c?.type === "default")) defaultName = value.text;
  }

  /** `module.exports = { a, b }`, `module.exports.x = …`, `exports.x = …`. */
  function recordCommonJsExport(node: Node) {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left || !right || !atModuleLevel()) return;
    const target = left.text.replace(/\s+/g, "");
    const member = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(target);
    if (member) {
      const name = member[1]!;
      exportedNames.add(name);
      if (right.type === "arrow_function" || right.type === "function_expression" || right.type === "function") add(name, "FUNCTION", node, { exported: true, signature: signatureOf(name, right) });
      return;
    }
    if (target !== "module.exports") return;
    if (right.type === "object") {
      for (const p of right.namedChildren) {
        if (p?.type === "shorthand_property_identifier") exportedNames.add(p.text);
        else if (p?.type === "pair") {
          const value = p.childForFieldName("value");
          if (value?.type === "identifier") exportedNames.add(value.text);
        }
      }
    } else if (right.type === "identifier") defaultName = right.text;
    else if ((right.type === "function_expression" || right.type === "class") && right.childForFieldName("name")) defaultName = right.childForFieldName("name")!.text;
  }

  // ---------------------------------------------------------------- Python

  function enterPy(node: Node): Scope | null {
    switch (node.type) {
      case "function_definition": {
        const name = node.childForFieldName("name")?.text ?? "";
        const inClass = scopes.at(-1)?.kind === "class";
        const i = add(name, inClass ? "METHOD" : "FUNCTION", node, { exported: atModuleLevel() && !name.startsWith("_"), signature: signatureOf(name, node) });
        return { symbol: i, kind: "function", name: inClass ? null : name };
      }
      case "class_definition": {
        const name = node.childForFieldName("name")?.text ?? "";
        const i = add(name, "CLASS", node, { exported: atModuleLevel() && !name.startsWith("_") });
        return { symbol: i, kind: "class", name };
      }
      case "lambda":
        return { symbol: -1, kind: "function", name: null };
      case "assignment": {
        if (!atModuleLevel()) return null;
        const left = node.childForFieldName("left");
        if (left?.type !== "identifier") return null;
        if (left.text === "__all__") {
          const right = node.childForFieldName("right");
          pyAll = new Set([...(right?.text ?? "").matchAll(/["']([A-Za-z_]\w*)["']/g)].map((m) => m[1]!));
        } else if (isUpperConstant(left.text)) add(left.text, "CONSTANT", node, { exported: !left.text.startsWith("_") });
        return null;
      }
      case "import_statement": {
        for (const c of node.namedChildren) {
          if (c?.type === "dotted_name") imports.push({ specifier: c.text, imported: "*", local: c.text.split(".")[0]!, line: line(node) });
          else if (c?.type === "aliased_import") {
            const name = c.childForFieldName("name")?.text ?? "";
            imports.push({ specifier: name, imported: "*", local: c.childForFieldName("alias")?.text ?? name, line: line(node) });
          }
        }
        return null;
      }
      case "import_from_statement": {
        const moduleName = node.childForFieldName("module_name")?.text ?? "";
        if (moduleName === "__future__") return null;
        for (const c of node.childrenForFieldName("name")) {
          const name = c.type === "aliased_import" ? (c.childForFieldName("name")?.text ?? "") : c.text;
          const local = c.type === "aliased_import" ? (c.childForFieldName("alias")?.text ?? name) : name;
          // `from . import orders` names a module (as the metrics pass records it: `.orders`).
          if (/^\.+$/.test(moduleName)) imports.push({ specifier: `${moduleName}${name}`, imported: "*", local, line: line(node) });
          else imports.push({ specifier: moduleName, imported: name, local, line: line(node) });
        }
        return null;
      }
      case "call": {
        const fn = node.childForFieldName("function");
        if (fn?.type === "identifier") recordCall(fn.text, null, node, false);
        else if (fn?.type === "attribute") {
          const attr = fn.childForFieldName("attribute");
          const obj = fn.childForFieldName("object");
          if (attr) recordCall(attr.text, obj ? snippet(obj.text, 60) : null, node, false);
        }
        return null;
      }
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------- walk (no recursion)

  const enter = js ? enterJs : enterPy;
  const cursor = ctx.tree.walk();
  const opened: Array<Scope | null> = [];
  const INTERESTING = js
    ? new Set([
        "function_declaration", "generator_function_declaration", "class_declaration", "abstract_class_declaration", "method_definition",
        "public_field_definition", "interface_declaration", "type_alias_declaration", "enum_declaration", "variable_declarator",
        "arrow_function", "function_expression", "function", "generator_function", "import_statement", "export_statement",
        "call_expression", "new_expression", "assignment_expression",
      ])
    : new Set(["function_definition", "class_definition", "lambda", "assignment", "import_statement", "import_from_statement", "call"]);
  outer: for (;;) {
    const scope = INTERESTING.has(cursor.nodeType) ? enter(cursor.currentNode) : null;
    if (scope) scopes.push(scope);
    if (cursor.gotoFirstChild()) {
      opened.push(scope);
      continue;
    }
    if (scope) scopes.pop();
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) break outer;
      if (opened.pop()) scopes.pop();
    }
  }
  cursor.delete();

  // Exports declared apart from the declaration.
  for (const s of symbols) {
    if (s.parent !== null) continue;
    if (exportedNames.has(s.name)) s.exported = true;
    if (defaultName && s.name === defaultName) {
      s.exported = true;
      s.isDefault = true;
    }
    if (py && pyAll) s.exported = (pyAll as Set<string>).has(s.name);
  }

  return { path: ctx.path, grammar: ctx.grammar, symbols, imports, calls, truncated };
}

/** Collects symbols through `analyzeCode`'s `onTree` hook. */
export function createSymbolCollector() {
  const files: FileSymbols[] = [];
  return {
    inspectTree(ctx: TreeContext) {
      if (ctx.kind !== "SOURCE" && ctx.kind !== "TEST") return;
      const result = extractSymbols(ctx);
      if (result) files.push(result);
    },
    files: () => files,
  };
}
