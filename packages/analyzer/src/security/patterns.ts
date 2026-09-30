import type { Node, Tree } from "web-tree-sitter";
import type { Severity } from "@pd/shared/constants";
import { snippet } from "../metrics/evidence";
import type { GrammarId } from "../metrics/languages";
import type { SecurityRuleKey } from "./rules";
import type { RawSecurityFinding } from "./types";

/**
 * Insecure-pattern detection on tree-sitter syntax trees. Rules match the
 * syntactic shape of a dangerous call (callee name, literal vs. dynamic
 * arguments, keyword flags), which is precise enough to avoid flagging
 * comments and strings while staying explainable. There is no data-flow
 * analysis: "dynamic" means "not a constant literal", not "proven tainted".
 */

type Emit = (node: Node, rule: SecurityRuleKey, severity: Severity, reason: string, data?: Record<string, unknown>) => void;

/** SQL text: a statement keyword at the start, or a clause pair anywhere. */
const SQL_RE = /^\s*(?:select|insert|update|delete|replace|merge|upsert|create|drop|alter|truncate|with|exec)\b|\bselect\b[\s\S]*\bfrom\b|\binsert\s+into\b|\bupdate\b[\s\S]*\bset\b|\bdelete\s+from\b|\bwhere\b[\s\S]*[=<>]/i;
/** Names of variables/keys that hold security-sensitive random values. */
const SENSITIVE_NAME = /token|secret|passw(?:or)?d|nonce|salt|otp|api_?key|session_?id|csrf|reset_?code|verification_?code|auth_?code/i;
const WEAK_HASHES = new Set(["md5", "md4", "md2", "sha1", "sha-1"]);

const unquote = (s: string) => s.replace(/^[rbuRBU]{0,2}(["'`]{1,3})([\s\S]*)\1$/, "$2");
const namedArgs = (list: Node | null | undefined): Node[] =>
  (list?.namedChildren ?? []).filter((c): c is Node => c !== null && c.type !== "comment" && c.type !== "line_comment" && c.type !== "block_comment");

// ---------------------------------------------------------------- literals

/** The value of a constant string literal (no interpolation), or null. */
function stringValue(n: Node | null | undefined): string | null {
  if (!n) return null;
  switch (n.type) {
    case "string":
      // JS/TS strings and Python strings (a Python f-string with interpolation is not constant).
      if (n.namedChildren.some((c) => c?.type === "interpolation")) return null;
      return n.namedChildren.some((c) => c?.type === "string_content")
        ? n.namedChildren.filter((c) => c?.type === "string_content").map((c) => c!.text).join("")
        : unquote(n.text);
    case "template_string":
      return n.namedChildren.some((c) => c?.type === "template_substitution") ? null : n.text.slice(1, -1);
    case "string_literal":
    case "text_block":
      return n.namedChildren.length > 0 ? n.namedChildren.map((c) => c!.text).join("") : unquote(n.text);
    case "concatenated_string": {
      const parts = n.namedChildren.map((c) => stringValue(c));
      return parts.every((p) => p !== null) ? parts.join("") : null;
    }
    case "parenthesized_expression":
      return stringValue(n.namedChildren[0]);
    default:
      return null;
  }
}

const CONSTANT_TYPES = new Set([
  "number", "integer", "float", "number_literal", "decimal_integer_literal", "hex_integer_literal",
  "true", "false", "null", "none", "undefined", "null_literal", "char_literal",
]);

/** A value fixed at write time: string/number/boolean literals. Anything else counts as dynamic. */
function isConstant(n: Node | null | undefined): boolean {
  return !!n && (stringValue(n) !== null || CONSTANT_TYPES.has(n.type));
}

const isFalse = (n: Node | null | undefined) => !!n && (n.type === "false" || n.text === "False" || n.text === "0" || n.text === "0L" || n.text === "FALSE");
const isTrue = (n: Node | null | undefined) => !!n && (n.type === "true" || n.text === "True" || n.text === "true");

/**
 * If `n` builds a string at runtime (concatenation, interpolation, % or
 * .format) out of literal parts that read as SQL, return those literal parts.
 */
function dynamicSql(n: Node | null | undefined): string | null {
  if (!n) return null;
  const literal: string[] = [];
  let dynamic = false;
  const visit = (x: Node | null | undefined): void => {
    if (!x) return;
    const value = stringValue(x);
    if (value !== null) {
      literal.push(value);
      return;
    }
    switch (x.type) {
      case "template_string": // JS `… ${x} …`
        dynamic = true;
        for (const c of x.namedChildren) if (c?.type === "string_fragment") literal.push(c.text);
        return;
      case "string": // Python f"… {x} …"
        dynamic = true;
        for (const c of x.namedChildren) if (c?.type === "string_content") literal.push(c.text);
        return;
      case "binary_expression": // JS/Java a + b
      case "binary_operator": {
        // Python a + b, "…" % x
        const op = x.childForFieldName("operator")?.text;
        if (op !== "+" && op !== "%") {
          dynamic = true;
          return;
        }
        visit(x.childForFieldName("left"));
        visit(x.childForFieldName("right"));
        if (op === "%") dynamic = true;
        return;
      }
      case "parenthesized_expression":
        visit(x.namedChildren[0]);
        return;
      case "call": {
        // Python "…".format(x)
        const fn = x.childForFieldName("function");
        if (fn?.type === "attribute" && fn.childForFieldName("attribute")?.text === "format") {
          dynamic = true;
          visit(fn.childForFieldName("object"));
          return;
        }
        dynamic = true;
        return;
      }
      case "method_invocation": {
        // Java String.format("…", x)
        if (x.childForFieldName("name")?.text === "format") {
          dynamic = true;
          visit(namedArgs(x.childForFieldName("arguments"))[0]);
          return;
        }
        dynamic = true;
        return;
      }
      default:
        dynamic = true;
    }
  };
  visit(n);
  const text = literal.join(" ");
  return dynamic && SQL_RE.test(text) ? text : null;
}

/** The name a value is assigned to (variable, property, keyword), looking a few levels up. */
function assignedName(node: Node): string | null {
  let n: Node | null = node.parent;
  for (let depth = 0; n && depth < 8; depth++, n = n.parent) {
    switch (n.type) {
      case "variable_declarator":
        return n.childForFieldName("name")?.text ?? null;
      case "assignment_expression":
      case "assignment":
      case "augmented_assignment":
        return n.childForFieldName("left")?.text ?? null;
      case "pair":
        return n.childForFieldName("key")?.text ?? null;
      case "keyword_argument":
        return n.childForFieldName("name")?.text ?? null;
      case "public_field_definition":
      case "field_definition":
        return (n.childForFieldName("name") ?? n.childForFieldName("property"))?.text ?? null;
      case "return_statement":
      case "statement_block":
      case "block":
      case "function_definition":
      case "function_declaration":
      case "method_declaration":
        return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------- JavaScript / TypeScript

function calleeText(fn: Node | null): string {
  return (fn?.text ?? "").replace(/\s+/g, "").replace(/\?\./g, ".");
}
const lastSegment = (callee: string) => callee.slice(callee.lastIndexOf(".") + 1);
const objectOf = (callee: string) => (callee.includes(".") ? callee.slice(0, callee.lastIndexOf(".")) : "");

function objectPairs(n: Node | null | undefined): Map<string, Node> {
  const out = new Map<string, Node>();
  if (n?.type !== "object" && n?.type !== "dictionary") return out;
  for (const p of n.namedChildren) {
    if (p?.type !== "pair") continue;
    const key = p.childForFieldName("key");
    const value = p.childForFieldName("value");
    if (key && value) out.set(unquote(key.text), value);
  }
  return out;
}

const JS_SQL_SINK = /^(?:query|execute|raw|queryRaw|executeRaw|\$queryRawUnsafe|\$executeRawUnsafe|unsafe|prepare|exec|whereRaw|havingRaw|orderByRaw|joinRaw|fromRaw)$/;

function inspectJs(root: Node, source: string, emit: Emit) {
  const childProcess = /(?:require\(\s*|from\s+|import\(\s*)["'](?:node:)?child_process["']/.test(source);

  for (const node of root.descendantsOfType(["call_expression", "new_expression", "assignment_expression", "pair", "jsx_attribute"])) {
    if (!node) continue;
    switch (node.type) {
      case "call_expression": {
        const argsNode = node.childForFieldName("arguments");
        if (argsNode?.type !== "arguments") break; // tagged templates (sql`…`) escape values
        const callee = calleeText(node.childForFieldName("function"));
        const last = lastSegment(callee);
        const obj = objectOf(callee);
        const args = namedArgs(argsNode);
        const a0 = args[0];

        if (callee === "eval" && a0 && !isConstant(a0)) {
          emit(node, "codeInjection", "HIGH", "passes a runtime value to `eval`");
        } else if ((callee === "setTimeout" || callee === "setInterval") && a0 && (a0.type === "template_string" || a0.type === "binary_expression") && stringValue(a0) === null) {
          emit(node, "codeInjection", "MEDIUM", `passes a string to \`${callee}\`, which is evaluated as code`);
        }

        const isChildProcess = /^(?:child_process|childProcess|cp)$/.test(obj) || (obj === "" && childProcess);
        if (isChildProcess && (last === "exec" || last === "execSync") && a0 && !isConstant(a0)) {
          emit(node, "commandInjection", "HIGH", `runs a dynamically built command through a shell with \`${last}\``);
        } else if (isChildProcess && /^(?:spawn|spawnSync|execFile|execFileSync)$/.test(last)) {
          const shell = objectPairs(args.find((a) => a.type === "object")).get("shell");
          if (shell && !isFalse(shell)) {
            emit(node, "commandInjection", a0 && !isConstant(a0) ? "HIGH" : "MEDIUM", `calls \`${last}\` with \`shell: true\`, so arguments are interpreted by a shell`);
          }
        }

        if (JS_SQL_SINK.test(last) && obj !== "" && obj !== "child_process" && obj !== "RegExp") {
          const sql = dynamicSql(a0);
          if (sql !== null) emit(node, "sqlInjection", "HIGH", `builds the SQL passed to \`${last}\` from runtime values`);
        }

        if ((callee === "document.write" || callee === "document.writeln") && a0 && !isConstant(a0)) {
          emit(node, "xss", "MEDIUM", `writes a runtime value as HTML with \`${callee}\``);
        } else if (last === "insertAdjacentHTML" && args[1] && !isConstant(args[1])) {
          emit(node, "xss", "MEDIUM", "inserts a runtime value as HTML with `insertAdjacentHTML`");
        }

        if (last === "createHash" && WEAK_HASHES.has((stringValue(a0) ?? "").toLowerCase())) {
          emit(node, "weakHash", "MEDIUM", `hashes with ${stringValue(a0)!.toUpperCase()}`);
        } else if (last === "createCipher" || last === "createDecipher") {
          emit(node, "weakCipher", "MEDIUM", `uses the deprecated \`${last}\`, which derives the key without a salt and uses no IV`);
        } else if ((last === "createCipheriv" || last === "createDecipheriv") && /des|rc4|rc2|bf-|blowfish|-ecb$/i.test(stringValue(a0) ?? "")) {
          emit(node, "weakCipher", "MEDIUM", `uses the weak cipher/mode \`${stringValue(a0)}\``);
        }

        if (callee === "Math.random") {
          const name = assignedName(node);
          if (name && SENSITIVE_NAME.test(name)) emit(node, "insecureRandom", "MEDIUM", `generates \`${name}\` with Math.random()`);
        }
        break;
      }
      case "new_expression": {
        const ctor = node.childForFieldName("constructor")?.text;
        const args = namedArgs(node.childForFieldName("arguments"));
        if (ctor === "Function" && args.some((a) => !isConstant(a))) {
          emit(node, "codeInjection", "HIGH", "creates a function from runtime strings with `new Function`");
        }
        break;
      }
      case "assignment_expression": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        const prop = left?.type === "member_expression" ? left.childForFieldName("property")?.text : undefined;
        if ((prop === "innerHTML" || prop === "outerHTML") && right && !isConstant(right)) {
          emit(node, "xss", "MEDIUM", `assigns a runtime value to \`${prop}\``);
        }
        if (/NODE_TLS_REJECT_UNAUTHORIZED["'\]]*$/.test(left?.text ?? "") && /^["'`]?0["'`]?$/.test(right?.text ?? "")) {
          emit(node, "tlsVerificationDisabled", "HIGH", "sets NODE_TLS_REJECT_UNAUTHORIZED to 0, disabling certificate checks for the whole process");
        }
        break;
      }
      case "pair": {
        const key = unquote(node.childForFieldName("key")?.text ?? "");
        const value = node.childForFieldName("value");
        if ((key === "rejectUnauthorized" || key === "strictSSL") && isFalse(value)) {
          emit(node, "tlsVerificationDisabled", "HIGH", `sets \`${key}: false\``);
        } else if (key === "NODE_TLS_REJECT_UNAUTHORIZED" && /^["'`]0["'`]$/.test(value?.text ?? "")) {
          emit(node, "tlsVerificationDisabled", "HIGH", "sets NODE_TLS_REJECT_UNAUTHORIZED to 0");
        } else if (key === "algorithms" && /["'`]none["'`]/i.test(value?.text ?? "")) {
          emit(node, "jwtVerificationDisabled", "HIGH", "allows the unsigned `none` JWT algorithm");
        }
        break;
      }
      case "jsx_attribute": {
        const name = node.namedChildren[0];
        if (name?.text !== "dangerouslySetInnerHTML") break;
        const html = objectPairs(node.namedChildren[1]?.namedChildren[0]).get("__html");
        if (!html || !isConstant(html)) emit(node, "xss", "MEDIUM", "renders a runtime value as raw HTML via `dangerouslySetInnerHTML`");
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- Python

const PY_SQL_SINK = /^(?:execute|executemany|executescript|mogrify|raw|text|read_sql|read_sql_query|extra)$/;
const PY_DESERIALIZE = /^(?:c?[Pp]ickle|dill|cloudpickle|marshal|joblib|jsonpickle)\.(?:load|loads|decode)$|^(?:pd|pandas)\.read_pickle$/;

function keywordArgs(argList: Node | null): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const a of namedArgs(argList)) {
    if (a.type !== "keyword_argument") continue;
    const name = a.childForFieldName("name")?.text;
    const value = a.childForFieldName("value");
    if (name && value) out.set(name, value);
  }
  return out;
}

function inspectPython(root: Node, path: string, emit: Emit) {
  for (const node of root.descendantsOfType(["call", "attribute", "pair", "assignment"])) {
    if (!node) continue;
    if (node.type === "attribute") {
      if (node.text === "ssl.CERT_NONE") emit(node, "tlsVerificationDisabled", "HIGH", "uses `ssl.CERT_NONE`, which accepts any certificate");
      continue;
    }
    if (node.type === "pair") {
      if (unquote(node.childForFieldName("key")?.text ?? "") === "verify_signature" && isFalse(node.childForFieldName("value"))) {
        emit(node, "jwtVerificationDisabled", "HIGH", "sets `verify_signature` to False");
      }
      continue;
    }
    if (node.type === "assignment") {
      if (/(?:^|\/)settings(?:\/[^/]+)?\.py$/.test(path) && node.childForFieldName("left")?.text === "DEBUG" && isTrue(node.childForFieldName("right"))) {
        emit(node, "debugMode", "MEDIUM", "sets Django `DEBUG = True` in a settings module");
      }
      continue;
    }

    const argList = node.childForFieldName("arguments");
    if (argList?.type !== "argument_list") continue; // generator-argument calls have no flags of interest
    const callee = calleeText(node.childForFieldName("function"));
    const last = lastSegment(callee);
    const obj = objectOf(callee);
    const positional = namedArgs(argList).filter((a) => a.type !== "keyword_argument" && a.type !== "list_splat" && a.type !== "dictionary_splat");
    const kw = keywordArgs(argList);
    const a0 = positional[0];

    if ((callee === "eval" || callee === "exec") && a0 && !isConstant(a0)) {
      emit(node, "codeInjection", "HIGH", `passes a runtime value to \`${callee}\``);
    }

    if (/^(?:os\.(?:system|popen|popen[234])|commands\.getoutput|commands\.getstatusoutput|subprocess\.getoutput|subprocess\.getstatusoutput)$/.test(callee) && a0 && !isConstant(a0)) {
      emit(node, "commandInjection", "HIGH", `runs a dynamically built command with \`${callee}\``);
    } else if (/^(?:run|call|check_call|check_output|Popen)$/.test(last) && /^(?:subprocess|sp)$/.test(obj) && isTrue(kw.get("shell"))) {
      const dynamicCmd = a0 && !isConstant(a0) && a0.type !== "list";
      emit(node, "commandInjection", dynamicCmd ? "HIGH" : "LOW", `calls \`${callee}\` with \`shell=True\`${dynamicCmd ? " and a dynamically built command" : ""}`);
    }

    if (PY_SQL_SINK.test(last) && dynamicSql(a0) !== null) {
      emit(node, "sqlInjection", "HIGH", `builds the SQL passed to \`${last}\` from runtime values`);
    }

    if (PY_DESERIALIZE.test(callee)) {
      emit(node, "deserialization", "HIGH", `deserializes with \`${callee}\`, which can execute code embedded in the data`);
    } else if (/^yaml\.(?:unsafe_load|unsafe_load_all)$/.test(callee)) {
      emit(node, "deserialization", "HIGH", `uses \`${callee}\`, which can construct arbitrary Python objects`);
    } else if (/^yaml\.(?:load|load_all)$/.test(callee)) {
      const loader = kw.get("Loader") ?? positional[1];
      if (!loader || !/Safe|Base/.test(loader.text)) {
        emit(node, "deserialization", "HIGH", `calls \`${callee}\` ${loader ? `with \`${loader.text}\`` : "without a safe Loader"}; use yaml.safe_load`);
      }
    } else if (callee === "shelve.open") {
      emit(node, "deserialization", "MEDIUM", "opens a shelve file, which is pickle-backed");
    }

    const verify = kw.get("verify");
    if (verify && isFalse(verify)) {
      if (/(?:^|\.)jwt\.decode$|^decode$/.test(callee)) emit(node, "jwtVerificationDisabled", "HIGH", `calls \`${callee}\` with \`verify=False\``);
      else emit(node, "tlsVerificationDisabled", "HIGH", `calls \`${callee}\` with \`verify=False\``);
    }
    if (callee === "ssl._create_unverified_context") emit(node, "tlsVerificationDisabled", "HIGH", "creates an SSL context that skips certificate verification");
    const algorithms = kw.get("algorithms");
    if (algorithms && /["']none["']/i.test(algorithms.text)) emit(node, "jwtVerificationDisabled", "HIGH", "allows the unsigned `none` JWT algorithm");

    if (/^hashlib\.(?:md5|sha1|md4)$/.test(callee) && !isFalse(kw.get("usedforsecurity"))) {
      emit(node, "weakHash", "MEDIUM", `hashes with ${last.toUpperCase()}`);
    } else if (callee === "hashlib.new" && WEAK_HASHES.has((stringValue(a0) ?? "").toLowerCase()) && !isFalse(kw.get("usedforsecurity"))) {
      emit(node, "weakHash", "MEDIUM", `hashes with ${stringValue(a0)!.toUpperCase()}`);
    }

    if (/(?:^|\.)(?:DES|DES3|ARC2|ARC4|Blowfish)\.new$/.test(callee)) {
      emit(node, "weakCipher", "MEDIUM", `uses the weak cipher \`${callee.split(".").at(-2)}\``);
    } else if (/(?:^|\.)(?:modes\.ECB|algorithms\.(?:TripleDES|ARC4|Blowfish|IDEA))$/.test(callee)) {
      emit(node, "weakCipher", "MEDIUM", `uses \`${callee}\``);
    } else if (positional.some((a) => /(?:^|\.)MODE_ECB$/.test(a.text))) {
      emit(node, "weakCipher", "MEDIUM", "encrypts in ECB mode");
    }

    if (/^random\.(?:random|randint|randrange|choice|choices|getrandbits|sample|uniform)$/.test(callee)) {
      const name = assignedName(node);
      if (name && SENSITIVE_NAME.test(name)) emit(node, "insecureRandom", "MEDIUM", `generates \`${name}\` with the \`random\` module`);
    }

    if (last === "run" && isTrue(kw.get("debug"))) {
      emit(node, "debugMode", "MEDIUM", "starts the app with `debug=True`");
    }
  }
}

// ---------------------------------------------------------------- Java

const JAVA_SQL_SINK = /^(?:executeQuery|executeUpdate|executeLargeUpdate|execute|addBatch|prepareStatement|prepareCall|createQuery|createNativeQuery|createSQLQuery|query|queryForObject|queryForList|queryForMap|queryForRowSet|update|batchUpdate)$/;

function inspectJava(root: Node, source: string, emit: Emit) {
  for (const node of root.descendantsOfType(["method_invocation", "object_creation_expression"])) {
    if (!node) continue;
    const args = namedArgs(node.childForFieldName("arguments"));
    const a0 = args[0];
    if (node.type === "object_creation_expression") {
      const type = node.childForFieldName("type")?.text ?? "";
      if (type === "ObjectInputStream" || type === "XMLDecoder") {
        emit(node, "deserialization", "MEDIUM", `creates a \`${type}\`; deserializing untrusted data with it can execute code`);
      } else if (type === "Random") {
        const name = assignedName(node);
        if (name && SENSITIVE_NAME.test(name)) emit(node, "insecureRandom", "MEDIUM", `generates \`${name}\` with java.util.Random`);
      }
      continue;
    }
    const name = node.childForFieldName("name")?.text ?? "";
    const obj = node.childForFieldName("object")?.text.replace(/\s+/g, "") ?? "";

    if (name === "exec" && /getRuntime\(\)$/.test(obj) && a0 && !isConstant(a0)) {
      emit(node, "commandInjection", "HIGH", "runs a dynamically built command with `Runtime.exec`");
    }
    if (JAVA_SQL_SINK.test(name) && dynamicSql(a0) !== null) {
      emit(node, "sqlInjection", "HIGH", `builds the SQL passed to \`${name}\` from runtime values`);
    }
    const algorithm = stringValue(a0) ?? "";
    if (obj === "MessageDigest" && name === "getInstance" && WEAK_HASHES.has(algorithm.toLowerCase())) {
      emit(node, "weakHash", "MEDIUM", `hashes with ${algorithm}`);
    } else if (obj === "DigestUtils" && /^(?:md5|sha1|md2)(?:Hex)?$/i.test(name)) {
      emit(node, "weakHash", "MEDIUM", `hashes with DigestUtils.${name}`);
    }
    if (obj === "Cipher" && name === "getInstance" && (/^(?:DES|DESede|RC2|RC4|ARCFOUR|Blowfish)\b/i.test(algorithm) || /\/ECB\//i.test(algorithm) || /^AES$/i.test(algorithm))) {
      emit(node, "weakCipher", "MEDIUM", /^AES$/i.test(algorithm) ? "uses `Cipher.getInstance(\"AES\")`, which defaults to ECB mode" : `uses the weak cipher/mode \`${algorithm}\``);
    }
    if (name === "random" && obj === "Math") {
      const target = assignedName(node);
      if (target && SENSITIVE_NAME.test(target)) emit(node, "insecureRandom", "MEDIUM", `generates \`${target}\` with Math.random()`);
    }
  }
  if (/ALLOW_ALL_HOSTNAME_VERIFIER|NoopHostnameVerifier|TrustAllStrategy/.test(source)) {
    for (const id of root.descendantsOfType(["identifier", "type_identifier"])) {
      if (id && /^(?:ALLOW_ALL_HOSTNAME_VERIFIER|NoopHostnameVerifier|TrustAllStrategy)$/.test(id.text)) {
        emit(id, "tlsVerificationDisabled", "HIGH", `uses \`${id.text}\`, which accepts any host or certificate`);
      }
    }
  }
}

// ---------------------------------------------------------------- C / C++

const C_UNBOUNDED: Record<string, { severity: Severity; instead: string }> = {
  gets: { severity: "HIGH", instead: "fgets" },
  strcpy: { severity: "MEDIUM", instead: "strncpy/strlcpy" },
  stpcpy: { severity: "MEDIUM", instead: "stpncpy" },
  strcat: { severity: "MEDIUM", instead: "strncat/strlcat" },
  sprintf: { severity: "MEDIUM", instead: "snprintf" },
  vsprintf: { severity: "MEDIUM", instead: "vsnprintf" },
  wcscpy: { severity: "MEDIUM", instead: "wcsncpy" },
  wcscat: { severity: "MEDIUM", instead: "wcsncat" },
};

function inspectC(root: Node, emit: Emit) {
  for (const node of root.descendantsOfType("call_expression")) {
    if (!node) continue;
    const fn = node.childForFieldName("function")?.text.replace(/^std::/, "") ?? "";
    const args = namedArgs(node.childForFieldName("arguments"));

    const unbounded = C_UNBOUNDED[fn];
    if (unbounded) emit(node, "unsafeCFunction", unbounded.severity, `calls \`${fn}\`, which does not bound the write; use ${unbounded.instead}`);
    const fmtIndex = fn === "scanf" ? 0 : fn === "fscanf" || fn === "sscanf" ? 1 : -1;
    if (fmtIndex >= 0 && /%\*?(?:s|\[)/.test(stringValue(args[fmtIndex]) ?? "")) {
      emit(node, "unsafeCFunction", "MEDIUM", `reads a string with \`${fn}\` and no field width`);
    }

    if (/^(?:system|popen|_popen|_wsystem|_wpopen)$/.test(fn) && args[0] && !isConstant(args[0])) {
      emit(node, "commandInjection", "HIGH", `runs a dynamically built command with \`${fn}\``);
    }
    if (fn === "curl_easy_setopt" && /^CURLOPT_SSL_VERIFY(?:PEER|HOST)$/.test(args[1]?.text ?? "") && isFalse(args[2])) {
      emit(node, "tlsVerificationDisabled", "HIGH", `turns off \`${args[1]!.text}\``);
    }
    if (/^(?:MD5|MD5_Init|MD4|SHA1|SHA1_Init|EVP_md5|EVP_md4|EVP_sha1)$/.test(fn)) {
      emit(node, "weakHash", "MEDIUM", `hashes with \`${fn}\``);
    } else if (/^EVP_(?:des|rc4|rc2|bf)_|^EVP_\w+_ecb$|^DES_(?:ecb_encrypt|set_key)/.test(fn)) {
      emit(node, "weakCipher", "MEDIUM", `uses the weak cipher/mode \`${fn}\``);
    }
  }
}

// ---------------------------------------------------------------- entry point

export function inspectTree(tree: Tree, grammar: GrammarId, source: string, path: string): RawSecurityFinding[] {
  const findings: RawSecurityFinding[] = [];
  const seen = new Set<string>();
  const emit: Emit = (node, rule, severity, reason, data) => {
    const dedupe = `${rule}:${node.startIndex}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    const line = node.startPosition.row + 1;
    const code = snippet(node.text, 100).replace(/`/g, "'");
    findings.push({
      rule,
      severity,
      line,
      endLine: node.endPosition.row + 1,
      evidence: `\`${code}\` at line ${line} ${reason}.`,
      key: `${rule}:${snippet(node.text, 80)}`,
      data: { ...data },
    });
  };
  const root = tree.rootNode;
  switch (grammar) {
    case "javascript":
    case "typescript":
    case "tsx":
      inspectJs(root, source, emit);
      break;
    case "python":
      inspectPython(root, path, emit);
      break;
    case "java":
      inspectJava(root, source, emit);
      break;
    case "c":
    case "cpp":
      inspectC(root, emit);
      break;
  }
  return findings.sort((a, b) => a.line - b.line);
}
