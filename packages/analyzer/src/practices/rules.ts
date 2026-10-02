/**
 * Rule catalogue and thresholds for the API, database, testing and documentation
 * analyzers. Thresholds are stored with every analysis (summary.practices.thresholds)
 * so a result can always be explained.
 */
export const PRACTICE_THRESHOLDS = {
  /** An API this large without a machine-readable specification is reported. */
  apiSpecEndpoints: 5,
  /** Production code lines below which a repository without tests is only MEDIUM. */
  noTestsHighLoc: 2000,
  /** Repositories smaller than this are not expected to have tests. */
  noTestsMinLoc: 200,
  /** Test code lines ÷ production code lines. */
  testRatio: { medium: 0.05, low: 0.2 },
  /** Line coverage from a committed report, in percent. */
  coverage: { medium: 50, low: 70 },
  /** Production files at least this large are listed when no test references them. */
  untestedFileLoc: 150,
  maxUntestedFiles: 20,
  /** A README shorter than this is reported as thin. */
  readmeMinWords: 150,
  maxBrokenLinks: 50,
} as const;

export type PracticeCategory = "API" | "DATABASE" | "TESTING" | "DOCUMENTATION";

export interface PracticeRuleDefinition {
  id: string;
  /** Short machine-friendly finding type, stored as Finding.type. */
  type: string;
  category: PracticeCategory;
  title: string;
  impact: string;
  recommendation: string;
  cwe?: string;
}

const rule = (r: PracticeRuleDefinition) => r;

export const PRACTICE_RULES = {
  // ---------------------------------------------------------------- API
  permissiveCors: rule({
    id: "api/permissive-cors",
    type: "permissive-cors",
    category: "API",
    title: "CORS allows any origin",
    cwe: "CWE-942",
    impact:
      "Any website can call this API from a visitor's browser. When the configuration also reflects the caller's origin with credentials, other sites can make authenticated requests as the signed-in user and read the responses.",
    recommendation:
      "List the origins that may call the API explicitly. Never combine a wildcard or reflected origin with credentials (cookies or Authorization headers).",
  }),
  errorDetailsExposed: rule({
    id: "api/error-details-exposed",
    type: "error-details-exposed",
    category: "API",
    title: "Stack trace or internal error returned to the client",
    cwe: "CWE-209",
    impact: "Stack traces reveal file paths, library versions and internal logic that help an attacker plan further attacks.",
    recommendation: "Log the full error on the server with a request id, and return a generic message (and the request id) to the client.",
  }),
  unauthenticatedMutation: rule({
    id: "api/unauthenticated-mutation",
    type: "unauthenticated-mutation",
    category: "API",
    title: "State-changing endpoint without a visible authentication check",
    cwe: "CWE-306",
    impact:
      "If the endpoint is really unprotected, anyone who can reach the server can create, change or delete data. The check is static: authentication applied somewhere this analysis cannot see (a gateway, a wrapper defined elsewhere) is not recognised.",
    recommendation:
      "Require an authenticated user (middleware, guard, decorator or an explicit check at the top of the handler) and check that the user may act on the resource. If the endpoint is public by design, mark the finding as Expected.",
  }),
  missingInputValidation: rule({
    id: "api/missing-input-validation",
    type: "missing-input-validation",
    category: "API",
    title: "Request body used without schema validation",
    cwe: "CWE-20",
    impact: "Unvalidated input reaches business logic and the database with unexpected types, missing fields or extra properties (mass assignment).",
    recommendation: "Parse the body with a schema (zod, Joi, Pydantic, Bean Validation, a DRF serializer …) and use only the parsed result.",
  }),
  authWithoutRateLimit: rule({
    id: "api/auth-without-rate-limit",
    type: "auth-without-rate-limit",
    category: "API",
    title: "Login endpoint without rate limiting",
    cwe: "CWE-307",
    impact: "Without a limit on attempts, passwords can be guessed by brute force or credential stuffing.",
    recommendation: "Limit failed attempts per account and per client IP (for example with a rate-limiting middleware), and add a delay or lockout after repeated failures.",
  }),
  noApiSpec: rule({
    id: "api/no-specification",
    type: "no-api-specification",
    category: "API",
    title: "HTTP API without a specification",
    impact: "Clients and new contributors have to read the code to learn which endpoints exist, what they accept and what they return; changes break clients unnoticed.",
    recommendation: "Publish an OpenAPI (Swagger) document, generated from the code where the framework supports it, or at least document the endpoints in docs/api.md.",
  }),

  // ---------------------------------------------------------------- database
  unindexedForeignKey: rule({
    id: "database/unindexed-foreign-key",
    type: "unindexed-foreign-key",
    category: "DATABASE",
    title: "Foreign key without an index",
    impact:
      "PostgreSQL, SQLite and SQL Server do not index foreign keys automatically. Joins and lookups by the relation, and deletes of the referenced row (which check for dependants), scan the whole table as it grows.",
    recommendation: "Add an index whose leading columns are the foreign-key columns (Prisma: @@index([…]); SQLAlchemy: index=True; SQL: CREATE INDEX).",
  }),
  tableWithoutPrimaryKey: rule({
    id: "database/table-without-primary-key",
    type: "table-without-primary-key",
    category: "DATABASE",
    title: "Table without a primary key",
    impact: "Rows cannot be identified reliably: duplicates creep in, updates and deletes may hit several rows, and logical replication and many ORMs refuse such tables.",
    recommendation: "Give every table a primary key, a surrogate id column if no natural key exists.",
  }),
  autoSchemaSync: rule({
    id: "database/auto-schema-sync",
    type: "auto-schema-sync",
    category: "DATABASE",
    title: "Schema changed automatically at start-up",
    impact:
      "The ORM alters (or drops and recreates) tables to match the code when the application starts. Changes are not reviewed or versioned, cannot be rolled back, and a mismatch can drop columns or data in production.",
    recommendation: "Disable automatic synchronisation outside local development and manage the schema with versioned migrations.",
  }),
  noMigrations: rule({
    id: "database/no-migrations",
    type: "no-migrations",
    category: "DATABASE",
    title: "Database schema without versioned migrations",
    impact: "Without migrations, schema changes cannot be reviewed, reproduced on another environment or rolled back, and databases drift apart.",
    recommendation: "Generate and commit migrations with the ORM's migration tool (prisma migrate, Django makemigrations, Alembic, TypeORM/Sequelize migrations, Flyway or Liquibase).",
  }),

  // ---------------------------------------------------------------- testing
  noTests: rule({
    id: "testing/no-tests",
    type: "no-tests",
    category: "TESTING",
    title: "No automated tests",
    impact: "Every change has to be verified by hand; regressions reach users and refactoring is risky.",
    recommendation: "Add a test framework and start with tests for the most important and most complex code paths, then run them on every change.",
  }),
  lowTestRatio: rule({
    id: "testing/low-test-ratio",
    type: "low-test-ratio",
    category: "TESTING",
    title: "Little test code compared with production code",
    impact: "Large parts of the code are probably not exercised by any test, so regressions there go unnoticed. The ratio is a size proxy, not a coverage measurement.",
    recommendation: "Add tests for the largest and most complex untested files first, and measure line coverage in CI.",
  }),
  lowCoverage: rule({
    id: "testing/low-coverage",
    type: "low-coverage",
    category: "TESTING",
    title: "Low line coverage in the committed coverage report",
    impact: "A large share of the code is not executed by the test suite. The value comes from the committed report and may be out of date.",
    recommendation: "Raise coverage of the critical code paths and enforce a minimum in CI rather than committing reports.",
  }),
  focusedTest: rule({
    id: "testing/focused-test",
    type: "focused-test",
    category: "TESTING",
    title: "Focused test (.only) committed",
    impact: "A focused test makes the runner skip every other test in the file or suite, so CI passes without running them.",
    recommendation: "Remove `.only` (or `fit`/`fdescribe`) before committing; most test runners can fail CI on focused tests (for example `--forbid-only`).",
  }),
  skippedTest: rule({
    id: "testing/skipped-test",
    type: "skipped-test",
    category: "TESTING",
    title: "Skipped test",
    impact: "A skipped test no longer protects the behaviour it describes; skips tend to become permanent.",
    recommendation: "Fix and re-enable the test, or delete it if the behaviour no longer exists. Record the reason and a ticket when a skip must stay.",
  }),
  testsNotInCi: rule({
    id: "testing/tests-not-in-ci",
    type: "tests-not-in-ci",
    category: "TESTING",
    title: "Tests are not run automatically",
    impact: "Tests that only run when someone remembers to start them stop being run, and failures are found late.",
    recommendation: "Run the test suite in CI on every push and pull request (GitHub Actions, GitLab CI, …) and block merging on failures.",
  }),
  noTestScript: rule({
    id: "testing/no-test-script",
    type: "no-test-script",
    category: "TESTING",
    title: "No working `npm test` script",
    impact: "Contributors and CI cannot run the tests with the conventional command.",
    recommendation: "Set `scripts.test` in package.json to the test runner (for example `vitest run` or `jest`).",
  }),
  untestedFile: rule({
    id: "testing/untested-file",
    type: "untested-file",
    category: "TESTING",
    title: "Large file that no test refers to",
    impact: "No test imports this file or is named after it, so its behaviour is probably only exercised indirectly or not at all.",
    recommendation: "Add tests for this file, starting with its most complex functions.",
  }),

  // ---------------------------------------------------------------- documentation
  missingReadme: rule({
    id: "documentation/missing-readme",
    type: "missing-readme",
    category: "DOCUMENTATION",
    title: "No README",
    impact: "Nobody can tell what the project does, how to install it or how to run it without reading the code.",
    recommendation: "Add a README.md with a short description, prerequisites, installation, configuration and usage instructions.",
  }),
  incompleteReadme: rule({
    id: "documentation/incomplete-readme",
    type: "incomplete-readme",
    category: "DOCUMENTATION",
    title: "README lacks essential sections",
    impact: "New users and contributors cannot set up or use the project from the README alone.",
    recommendation: "Add the missing sections: what the project does, how to install and configure it, and how to run and use it.",
  }),
  missingLicense: rule({
    id: "documentation/missing-license",
    type: "missing-license",
    category: "DOCUMENTATION",
    title: "No license file",
    impact: "Without a license, others have no legal permission to use, modify or distribute the code, even if it is public.",
    recommendation: "Add a LICENSE file with the license text (for example MIT or Apache-2.0), or state explicitly that the code is proprietary.",
  }),
  undocumentedEnvVars: rule({
    id: "documentation/undocumented-env-vars",
    type: "undocumented-env-vars",
    category: "DOCUMENTATION",
    title: "Environment variables used in code but not documented",
    impact: "Deployments fail or misbehave because required configuration is unknown until the code is read.",
    recommendation: "List every environment variable in a committed template (.env.example) or in the README, with a description and a safe example value.",
  }),
  brokenLink: rule({
    id: "documentation/broken-link",
    type: "broken-link",
    category: "DOCUMENTATION",
    title: "Documentation links to a file that does not exist",
    impact: "Readers following the documentation hit dead ends; the link usually points at a renamed or deleted file.",
    recommendation: "Update the link to the file's current location or remove it.",
  }),
} as const;

export type PracticeRuleKey = keyof typeof PRACTICE_RULES;
