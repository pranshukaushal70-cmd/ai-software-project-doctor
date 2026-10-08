import { defineProject } from "vitest/config";

// Unit tests of the e2e tooling only (model stub, ZIP writer). The Playwright specs in specs/
// need the running stack and are run by `npm run e2e`, never by vitest.
export default defineProject({
  test: { name: "e2e-tooling", environment: "node", include: ["model-stub/**/*.test.ts", "lib/**/*.test.ts"] },
});
