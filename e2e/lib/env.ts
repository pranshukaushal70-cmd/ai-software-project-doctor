/**
 * Where the end-to-end tests find the stack (docker-compose.e2e.yml). The browser and the API
 * client must use the same origin as the app's APP_URL: production cookies are `Secure` (kept
 * by browsers over http only for localhost) and POSTs are checked against the Origin header.
 */
export const BASE_URL = (process.env.E2E_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const STUB_URL = (process.env.E2E_STUB_URL ?? "http://localhost:4010").replace(/\/$/, "");

/**
 * Whether the stack runs with the sandbox override (docker-compose.sandbox.yml): the tests
 * then approve and run the fixture's tests in Docker. Asserted against the API, so a
 * misconfigured stack fails instead of silently skipping the sandbox checks.
 */
export const SANDBOX_EXPECTED = process.env.E2E_SANDBOX === "1";

/** Where global setup leaves the test users (git-ignored). */
export const AUTH_DIR = new URL("../.auth/", import.meta.url);
