import { defineProject } from "vitest/config";

// Only the harness tests: the fixtures carry their own (node:test) suites, which are data here.
export default defineProject({
  test: { name: "benchmarks", environment: "node", include: ["test/**/*.test.ts"], env: { LOG_LEVEL: "silent" }, testTimeout: 120_000 },
});
