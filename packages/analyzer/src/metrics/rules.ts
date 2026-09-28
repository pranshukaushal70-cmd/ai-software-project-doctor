import type { Severity } from "@pd/shared/constants";

/**
 * Thresholds for code-quality findings. They are stored with every analysis
 * (summary.codeMetrics.thresholds) so a result can always be explained.
 * Values follow common static-analysis defaults (ESLint, SonarQube, PMD).
 * Each value is a limit: a finding is raised when the measurement EXCEEDS it.
 */
export const CODE_THRESHOLDS = {
  complexity: { medium: 10, high: 20 },
  nesting: { medium: 4, high: 6 },
  functionCodeLines: { medium: 60, high: 150 },
  parameters: { low: 5, medium: 7 },
  fileCodeLines: { low: 500, medium: 1000, high: 2000 },
  classMethods: 20,
  classCodeLines: 500,
  duplicateMinTokens: 50,
  duplicateMinLines: 6,
  duplicateMediumLines: 30,
} as const;

export interface RuleDefinition {
  id: string;
  /** Short machine-friendly finding type, stored as Finding.type. */
  type: string;
  title: string;
  impact: string;
  recommendation: string;
}

const rule = (r: RuleDefinition) => r;

export const RULES = {
  complexity: rule({
    id: "complexity/high-cyclomatic",
    type: "high-complexity",
    title: "Function has high cyclomatic complexity",
    impact:
      "Each decision point adds an execution path. Functions with many paths are harder to understand, need more test cases for full branch coverage, and are statistically more defect-prone.",
    recommendation:
      "Split the function into smaller functions with one responsibility each, replace long if/else or switch chains with lookup tables or polymorphism, and use early returns (guard clauses) for edge cases.",
  }),
  nesting: rule({
    id: "complexity/deep-nesting",
    type: "deep-nesting",
    title: "Deeply nested control flow",
    impact: "Deep nesting forces readers to keep many conditions in mind at once and hides the main path through the code.",
    recommendation: "Invert conditions into guard clauses, extract inner loops or branches into named helper functions, and flatten nested try blocks.",
  }),
  longFunction: rule({
    id: "size/long-function",
    type: "long-function",
    title: "Function is too long",
    impact: "Long functions usually do several things at once, which makes them hard to name, test and change safely.",
    recommendation: "Extract cohesive steps into well-named helper functions so the top-level function reads as a summary of what it does.",
  }),
  longParameterList: rule({
    id: "smell/long-parameter-list",
    type: "long-parameter-list",
    title: "Function takes many parameters",
    impact: "Long parameter lists are easy to call with arguments in the wrong order and often signal that the function has too many responsibilities.",
    recommendation: "Group related parameters into an options object or data class, or split the function.",
  }),
  largeFile: rule({
    id: "size/large-file",
    type: "large-file",
    title: "File is very large",
    impact: "Very large files tend to mix unrelated concerns, cause merge conflicts, and are slow to navigate and review.",
    recommendation: "Split the file by responsibility into smaller modules with clear interfaces.",
  }),
  godClass: rule({
    id: "smell/god-class",
    type: "god-class",
    title: "Class has too many responsibilities",
    impact: "Classes with many methods or lines usually accumulate unrelated responsibilities, which couples features together and makes changes risky.",
    recommendation: "Identify groups of methods that work on the same data and extract them into separate classes; prefer composition over one central class.",
  }),
  emptyCatch: rule({
    id: "smell/empty-catch",
    type: "empty-catch",
    title: "Exception is silently swallowed",
    impact: "An empty catch/except block hides failures, so errors surface later as corrupted state or confusing behaviour that is hard to trace.",
    recommendation:
      "Handle the error, log it with context, or rethrow it. If ignoring it is intentional, catch the narrowest exception type and add a comment explaining why.",
  }),
  bareExcept: rule({
    id: "smell/bare-except",
    type: "bare-except",
    title: "Bare `except:` catches every exception",
    impact: "A bare except also catches KeyboardInterrupt and SystemExit, which can make the program impossible to stop and hides programming errors.",
    recommendation: "Catch the specific exceptions you expect, or at least `except Exception:`, and handle or log them.",
  }),
  debugger: rule({
    id: "smell/debugger-statement",
    type: "debugger-statement",
    title: "Leftover `debugger` statement",
    impact: "A `debugger` statement pauses execution whenever developer tools are open and is almost always an accidental leftover.",
    recommendation: "Remove the statement; use breakpoints in the debugger instead.",
  }),
  todo: rule({
    id: "smell/todo-comment",
    type: "todo-comment",
    title: "Unresolved TODO/FIXME comment",
    impact: "TODO and FIXME markers record known incomplete or broken behaviour that has not been tracked or fixed.",
    recommendation: "Resolve the item, or move it to the issue tracker and reference the issue in the comment.",
  }),
  duplicate: rule({
    id: "duplication/duplicate-block",
    type: "duplicate-code",
    title: "Duplicated code block",
    impact: "Duplicated code must be changed in several places; fixes applied to one copy are easily missed in the others.",
    recommendation: "Extract the shared logic into a function or module used by both locations.",
  }),
  unreachable: rule({
    id: "dead-code/unreachable",
    type: "unreachable-code",
    title: "Unreachable code",
    impact: "Code after a return, throw, break or continue can never run. It misleads readers and often indicates a logic error.",
    recommendation: "Delete the unreachable statements, or fix the control flow if they were meant to run.",
  }),
  unusedImport: rule({
    id: "dead-code/unused-import",
    type: "unused-import",
    title: "Unused import",
    impact: "Unused imports add load time and false dependencies, and make it harder to see what a module really depends on.",
    recommendation: "Remove the import. If it is imported only for side effects, import the module without binding a name.",
  }),
  unusedPrivate: rule({
    id: "dead-code/unused-private",
    type: "unused-private-member",
    title: "Private function is never used",
    impact: "A private or file-local function that nothing calls is dead code that still has to be read and maintained.",
    recommendation: "Delete the function, or call it where it was intended to be used.",
  }),
} as const;

export type RuleKey = keyof typeof RULES;

export function complexitySeverity(value: number): Severity | null {
  if (value > CODE_THRESHOLDS.complexity.high) return "HIGH";
  if (value > CODE_THRESHOLDS.complexity.medium) return "MEDIUM";
  return null;
}

export function nestingSeverity(depth: number): Severity | null {
  if (depth > CODE_THRESHOLDS.nesting.high) return "HIGH";
  if (depth > CODE_THRESHOLDS.nesting.medium) return "MEDIUM";
  return null;
}

export function functionLengthSeverity(codeLines: number): Severity | null {
  if (codeLines > CODE_THRESHOLDS.functionCodeLines.high) return "HIGH";
  if (codeLines > CODE_THRESHOLDS.functionCodeLines.medium) return "MEDIUM";
  return null;
}

export function parameterSeverity(count: number): Severity | null {
  if (count > CODE_THRESHOLDS.parameters.medium) return "MEDIUM";
  if (count > CODE_THRESHOLDS.parameters.low) return "LOW";
  return null;
}

export function fileSizeSeverity(codeLines: number): Severity | null {
  if (codeLines > CODE_THRESHOLDS.fileCodeLines.high) return "HIGH";
  if (codeLines > CODE_THRESHOLDS.fileCodeLines.medium) return "MEDIUM";
  if (codeLines > CODE_THRESHOLDS.fileCodeLines.low) return "LOW";
  return null;
}
