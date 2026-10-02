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
  // security
  "private-key": "Private key",
  "cloud-credential": "Cloud credential",
  "api-token": "API token",
  "database-credentials": "Database credentials",
  "json-web-token": "JSON Web Token",
  "hardcoded-credential": "Hard-coded credential",
  "committed-env-file": "Committed .env file",
  "code-injection": "Code injection",
  "command-injection": "Command injection",
  "sql-injection": "SQL injection",
  xss: "Cross-site scripting",
  "insecure-deserialization": "Unsafe deserialization",
  "tls-verification-disabled": "TLS verification disabled",
  "jwt-verification-disabled": "JWT verification disabled",
  "weak-hash": "Weak hash",
  "weak-cipher": "Weak cipher",
  "insecure-randomness": "Insecure randomness",
  "unsafe-c-function": "Unsafe C function",
  "debug-mode": "Debug mode",
  // dependencies
  "vulnerable-dependency": "Vulnerable dependency",
  "missing-lockfile": "Missing lockfile",
  "unpinned-dependency": "Unpinned version",
  "non-registry-dependency": "Git / URL dependency",
  "unused-dependency": "Unused dependency",
  // architecture
  "circular-dependency": "Circular import",
  "layer-violation": "Layer violation",
  "high-fan-out": "High fan-out",
  // API
  "permissive-cors": "Permissive CORS",
  "error-details-exposed": "Stack trace exposed",
  "unauthenticated-mutation": "No visible auth check",
  "missing-input-validation": "Unvalidated request body",
  "auth-without-rate-limit": "Login without rate limit",
  "no-api-specification": "No API specification",
  // database
  "unindexed-foreign-key": "Unindexed foreign key",
  "table-without-primary-key": "No primary key",
  "auto-schema-sync": "Automatic schema sync",
  "no-migrations": "No migrations",
  // testing
  "no-tests": "No tests",
  "low-test-ratio": "Little test code",
  "low-coverage": "Low coverage",
  "focused-test": "Focused test",
  "skipped-test": "Skipped test",
  "tests-not-in-ci": "Tests not in CI",
  "no-test-script": "No test script",
  "untested-file": "Untested file",
  // documentation
  "missing-readme": "No README",
  "incomplete-readme": "Incomplete README",
  "missing-license": "No license",
  "undocumented-env-vars": "Undocumented env vars",
  "broken-link": "Broken link",
};

export const CATEGORY_LABEL: Record<string, string> = {
  CODE_QUALITY: "Code quality",
  SECURITY: "Security",
  SECRET: "Secret",
  DEPENDENCY: "Dependency",
  ARCHITECTURE: "Architecture",
  API: "API",
  DATABASE: "Database",
  TESTING: "Testing",
  DOCUMENTATION: "Documentation",
};

/** Grade colours follow the severity scale: A/B healthy, C medium, D high, F critical. */
export const GRADE_TONE = { A: "ok", B: "ok", C: "medium", D: "high", F: "critical" } as const;

/** Where a secret was found (summary.security.totals.secretsByContext / finding.data.context). Production contexts get no badge. */
export const SECRET_CONTEXT_BADGE: Record<string, string> = {
  test: "Test fixture",
  documentation: "Docs example",
  template: "Template",
};

export const ECOSYSTEM_LABEL: Record<string, string> = {
  npm: "npm",
  PyPI: "PyPI",
  Maven: "Maven",
  Go: "Go",
  "crates.io": "Cargo",
};

export const LAYER_LABEL: Record<string, string> = {
  interface: "Interface",
  service: "Service",
  data: "Data",
  shared: "Shared",
};

export const typeLabel = (type: string) => FINDING_TYPE_LABEL[type] ?? type;
