import type { SeverityDto } from "./types";

export const LANGUAGE_NAMES: Record<string, string> = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  python: "Python",
  java: "Java",
  c: "C",
  cpp: "C++",
};

export const SEVERITY_TONE = {
  CRITICAL: "critical",
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
  INFO: "neutral",
} as const satisfies Record<SeverityDto, string>;

export const SEVERITY_LABEL: Record<SeverityDto, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  INFO: "Info",
};

export const FINDING_TYPE_LABEL: Record<string, string> = {
  "high-complexity": "High complexity",
  "deep-nesting": "Deep nesting",
  "long-function": "Long function",
  "long-parameter-list": "Long parameter list",
  "large-file": "Large file",
  "god-class": "God class",
  "empty-catch": "Empty catch",
  "bare-except": "Bare except",
  "debugger-statement": "debugger statement",
  "todo-comment": "TODO / FIXME",
  "duplicate-code": "Duplicate code",
  "unreachable-code": "Unreachable code",
  "unused-import": "Unused import",
  "unused-private-member": "Unused private function",
};

export const typeLabel = (type: string) => FINDING_TYPE_LABEL[type] ?? type;
