import { expect, test } from "@playwright/test";
import { Session } from "../../lib/client";
import { BASE_URL } from "../../lib/env";
import { users } from "../../lib/flows";

// Phase 1/10: health, authentication and the request-level protections every route shares.

test("health endpoint reports the database and Redis as ok, without details", async () => {
  const res = await Session.anonymous().get<{ status: string; checks: Record<string, string> }>("/api/health");
  expect(res.status).toBe(200);
  expect(res.data).toEqual({ status: "ok", checks: { database: "ok", redis: "ok" } });
  expect(res.headers.get("cache-control")).toContain("no-store");
});

test("responses carry a request id and the production security headers", async () => {
  const res = await Session.anonymous().get("/api/health");
  expect(res.headers.get("x-request-id")).toBeTruthy();
  const page = await fetch(`${BASE_URL}/login`);
  expect(page.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(page.headers.get("x-powered-by")).toBeNull();
});

test("the session cookie is HttpOnly, Secure and SameSite=Lax", async () => {
  const { ownerUser } = users();
  // Logging in (not signing up) keeps the sign-up budget for the other specs.
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE_URL },
    body: JSON.stringify({ email: ownerUser.email, password: ownerUser.password }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith("pd_session="))!;
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/Secure/i);
  expect(cookie).toMatch(/SameSite=Lax/i);
});

test("unauthenticated API requests are refused", async () => {
  const anon = Session.anonymous();
  expect((await anon.get("/api/auth/me")).status).toBe(401);
  expect((await anon.get("/api/repositories")).status).toBe(401);
  expect((await anon.get("/api/reports")).status).toBe(401);
});

test("cross-site and Origin-less mutating requests are refused", async () => {
  const { owner } = users();
  const crossSite = await owner.post("/api/analysis/demo", undefined, { origin: "https://evil.example" });
  expect(crossSite.status).toBe(403);
  const noOrigin = await owner.post("/api/analysis/demo", undefined, { origin: null });
  expect(noOrigin.status).toBe(403);
});

test("a wrong password does not log in", async () => {
  const { ownerUser } = users();
  const res = await Session.anonymous().post("/api/auth/login", { email: ownerUser.email, password: "not-the-password" });
  expect(res.status).toBe(401);
  expect(res.headers.getSetCookie().some((c) => c.startsWith("pd_session=") && !c.includes("Max-Age=0"))).toBe(false);
});
