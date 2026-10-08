import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/worker", "apps/web", "e2e", "benchmarks"],
  },
});
