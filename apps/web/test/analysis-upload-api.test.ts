import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------------ mocks: session, database, queue, rate limit

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com", name: "User One" } as { id: string; email: string; name: string } | null,
  repositoriesCreated: 0,
  rateLimited: [] as Array<[string, string]>,
}));

vi.mock("@/server/auth/session", async () => {
  const { AppError } = await import("@pd/shared");
  return {
    requireApiUser: async () => {
      if (!state.user) throw new AppError("UNAUTHENTICATED", "Please sign in");
      return state.user;
    },
  };
});
vi.mock("@pd/db", () => ({
  getPrisma: () => ({
    repository: {
      create: async () => {
        state.repositoriesCreated++;
        return { id: "repo1" };
      },
    },
  }),
}));
vi.mock("@/server/queue", () => ({ enqueueAnalysis: async () => {} }));
vi.mock("@/server/rate-limit", () => ({
  rateLimit: async (policy: string, key: string) => void state.rateLimited.push([policy, key]),
}));

const analysisRoute = await import("@/app/api/analysis/route");

const ORIGIN = "http://localhost:3000";
function upload(name: string, type: string) {
  const form = new FormData();
  form.set("file", new File(["not a zip"], name, { type }));
  form.set("mode", "LOCAL_ONLY");
  return analysisRoute.POST(new NextRequest(`${ORIGIN}/api/analysis`, { method: "POST", headers: { origin: ORIGIN }, body: form }), { params: Promise.resolve({}) });
}
const errorCode = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code;

beforeEach(() => {
  state.user = { id: "u1", email: "u1@example.com", name: "User One" };
  state.repositoriesCreated = 0;
  state.rateLimited = [];
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/analysis with a ZIP upload", () => {
  it("is refused when ZIP_UPLOADS_ENABLED is false, before rate limiting or storing anything", async () => {
    vi.stubEnv("ZIP_UPLOADS_ENABLED", "false");
    const res = await upload("project.zip", "application/zip");
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("FORBIDDEN");
    expect(state.rateLimited).toEqual([]);
    expect(state.repositoriesCreated).toBe(0);
  });

  it("still requires a signed-in user while uploads are off", async () => {
    vi.stubEnv("ZIP_UPLOADS_ENABLED", "false");
    state.user = null;
    expect((await upload("project.zip", "application/zip")).status).toBe(401);
  });

  it("validates uploads as before when they are on", async () => {
    vi.stubEnv("ZIP_UPLOADS_ENABLED", "true");
    const res = await upload("notes.txt", "text/plain");
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("VALIDATION_ERROR");
    expect(state.rateLimited).toEqual([["upload", "u1"]]);
    expect(state.repositoriesCreated).toBe(0);
  });
});
