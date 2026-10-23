import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signupEnabled } from "@/server/auth/signup";

// ------------------------------------------------------------------ mocks: database, password hashing, session, rate limit

const state = vi.hoisted(() => ({
  created: [] as Array<{ email: string }>,
  sessions: [] as string[],
  rateLimited: [] as Array<[string, string]>,
}));

vi.mock("@pd/db", () => ({
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
  getPrisma: () => ({
    user: {
      create: async ({ data }: { data: { email: string; name: string } }) => {
        state.created.push({ email: data.email });
        return { id: "u1", email: data.email, name: data.name };
      },
    },
  }),
}));
vi.mock("@/server/auth/password", () => ({ hashPassword: async () => "hash" }));
vi.mock("@/server/auth/session", () => ({ createSession: async (userId: string) => void state.sessions.push(userId) }));
vi.mock("@/server/rate-limit", () => ({
  rateLimit: async (policy: string, key: string) => void state.rateLimited.push([policy, key]),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));

const signupRoute = await import("@/app/api/auth/signup/route");
const SignupPage = (await import("@/app/(auth)/signup/page")).default;

const ORIGIN = "http://localhost:3000";
const signUp = () =>
  signupRoute.POST(
    new NextRequest(`${ORIGIN}/api/auth/signup`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ name: "New User", email: "new@example.com", password: "a-long-password" }),
    }),
    { params: Promise.resolve({}) },
  );

beforeEach(() => {
  state.created = [];
  state.sessions = [];
  state.rateLimited = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("signupEnabled", () => {
  it("follows SIGNUP_ENABLED and otherwise stays closed in production only", () => {
    expect(signupEnabled({ NODE_ENV: "production", SIGNUP_ENABLED: "true" })).toBe(true);
    expect(signupEnabled({ NODE_ENV: "production", SIGNUP_ENABLED: "1" })).toBe(true);
    expect(signupEnabled({ NODE_ENV: "development", SIGNUP_ENABLED: "false" })).toBe(false);
    expect(signupEnabled({ NODE_ENV: "development", SIGNUP_ENABLED: "0" })).toBe(false);
    expect(signupEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(signupEnabled({ NODE_ENV: "production", SIGNUP_ENABLED: "" })).toBe(false);
    // A typo fails closed in production.
    expect(signupEnabled({ NODE_ENV: "production", SIGNUP_ENABLED: "yes" })).toBe(false);
    expect(signupEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(signupEnabled({ NODE_ENV: "test" })).toBe(true);
  });
});

describe("POST /api/auth/signup", () => {
  it("is refused while registration is closed, before rate limiting or creating anything", async () => {
    vi.stubEnv("SIGNUP_ENABLED", "false");
    const res = await signUp();
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: { code: string } }).error?.code).toBe("FORBIDDEN");
    expect(state.rateLimited).toEqual([]);
    expect(state.created).toEqual([]);
    expect(state.sessions).toEqual([]);
  });

  it("is closed by default in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SIGNUP_ENABLED", "");
    expect((await signUp()).status).toBe(403);
    expect(state.created).toEqual([]);
  });

  it("registers and signs in as before when registration is open", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SIGNUP_ENABLED", "true");
    const res = await signUp();
    expect(res.status).toBe(201);
    expect(state.created).toEqual([{ email: "new@example.com" }]);
    expect(state.sessions).toEqual(["u1"]);
    expect(state.rateLimited).toEqual([["signup", "local"]]);
  });
});

describe("signup page", () => {
  it("explains that registration is closed instead of showing the form", () => {
    vi.stubEnv("SIGNUP_ENABLED", "false");
    const html = renderToStaticMarkup(createElement(SignupPage));
    expect(html).toContain("Registration is closed");
    expect(html).toContain('href="/login"');
    expect(html).not.toContain("<form");
  });

  it("shows the registration form when registration is open", () => {
    vi.stubEnv("SIGNUP_ENABLED", "true");
    const html = renderToStaticMarkup(createElement(SignupPage));
    expect(html).toContain("Create your account");
    expect(html).toContain("<form");
  });
});
