import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./lib/env";

/**
 * End-to-end tests against the compose stack (docker-compose.e2e.yml): the production web
 * and worker images, PostgreSQL, Redis and the deterministic model stub. Start the stack
 * first (`npm run e2e:up`); see docs/testing.md.
 *
 * One worker, in file order: the specs share one stack (and its per-user rate limits), and
 * analyses are cached between specs in the same process.
 */
export default defineConfig({
  testDir: "specs",
  globalSetup: "./global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 5 * 60_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }], ["github"]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "api", testMatch: "api/**/*.spec.ts" },
    { name: "browser", testMatch: "ui/**/*.spec.ts", use: { ...devices["Desktop Chrome"], storageState: "./.auth/owner-state.json" } },
  ],
});
