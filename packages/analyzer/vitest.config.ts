import { configDefaults, defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "analyzer",
    environment: "node",
    testTimeout: 30_000,
    // Fixture repositories contain their own (intentionally imperfect) test files.
    exclude: [...configDefaults.exclude, "test/fixtures/**"],
  },
});
