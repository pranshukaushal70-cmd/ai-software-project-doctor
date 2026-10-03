import type { Severity } from "@pd/shared/constants";
import { kindOfPath } from "../classify";
import { grammarFor } from "../metrics/languages";
import { parseSource } from "../metrics/parser";
import type { FileKind } from "../scanner";
import { detectLanguage, isAnalyzedLanguage } from "../scanner/languages";
import { inspectTree } from "../security/patterns";
import { SECURITY_RULES } from "../security/rules";
import { scanTextForSecrets } from "../security/secrets";

/**
 * Inspects one file's content in memory with the same rules the analysis applies
 * (tree-sitter parse, insecure-pattern rules, secret rules), without reading or
 * writing anything. Used to compare a file before and after a proposed change, so a
 * change that breaks the syntax or introduces a finding is caught before anyone
 * sees it as a valid result. Finding keys are content-based, not line-based, so the
 * same finding has the same key after lines move.
 */

export interface InspectedFinding {
  ruleId: string;
  title: string;
  severity: Severity;
  line: number;
  /** Stable identity within the file (never derived from a secret value). */
  key: string;
}

export interface SourceInspection {
  /** True when a grammar parsed the file (analysed languages only). */
  parsed: boolean;
  /** ERROR and MISSING nodes in the syntax tree; 0 when not parsed. */
  syntaxErrors: number;
  /** Parsing exceeded the time limit. */
  timedOut: boolean;
  findings: InspectedFinding[];
}

const PARSE_TIMEOUT_MS = 5000;

export async function inspectSource(path: string, source: string, kind: FileKind = kindOfPath(path)): Promise<SourceInspection> {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const findings: InspectedFinding[] = [];
  const add = (f: { rule: keyof typeof SECURITY_RULES; severity: Severity; line: number; key: string }) => {
    const rule = SECURITY_RULES[f.rule];
    findings.push({ ruleId: rule.id, title: rule.title, severity: f.severity, line: f.line, key: f.key });
  };
  for (const f of scanTextForSecrets(text, { path, kind, isEnvFile: false, isEnvTemplate: false })) add(f);

  const language = detectLanguage(path);
  let parsed = false;
  let syntaxErrors = 0;
  let timedOut = false;
  if (isAnalyzedLanguage(language) && (kind === "SOURCE" || kind === "TEST")) {
    const grammar = grammarFor(language, path);
    const tree = await parseSource(grammar, text, PARSE_TIMEOUT_MS);
    if (!tree) timedOut = true;
    else {
      try {
        parsed = true;
        syntaxErrors = countSyntaxErrors(tree);
        // As in the analysis, insecure patterns are only reported for production source.
        if (kind === "SOURCE") for (const f of inspectTree(tree, grammar, text, path)) add(f);
      } finally {
        tree.delete();
      }
    }
  }
  return { parsed, syntaxErrors, timedOut, findings };
}

function countSyntaxErrors(tree: { walk(): import("web-tree-sitter").TreeCursor }): number {
  const cursor = tree.walk();
  let errors = 0;
  try {
    for (;;) {
      if (cursor.nodeType === "ERROR" || cursor.nodeIsMissing) errors++;
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return errors;
      }
    }
  } finally {
    cursor.delete();
  }
}
