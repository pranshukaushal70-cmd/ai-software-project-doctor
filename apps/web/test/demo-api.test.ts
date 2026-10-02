import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------------ mocks: session, database, queue, rate limit

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com", name: "User One" } as { id: string; email: string; name: string } | null,
  db: null as unknown,
  enqueued: [] as string[],
  rateLimited: [] as Array<[string, string]>,
  limitExceeded: false,
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
vi.mock("@pd/db", () => ({ getPrisma: () => state.db }));
vi.mock("@/server/queue", () => ({ enqueueAnalysis: async (id: string) => void state.enqueued.push(id) }));
vi.mock("@/server/rate-limit", async () => {
  const { AppError } = await import("@pd/shared");
  return {
    rateLimit: async (policy: string, key: string) => {
      state.rateLimited.push([policy, key]);
      if (state.limitExceeded) throw new AppError("RATE_LIMITED", "Too many requests. Please try again later.", { details: { retryAfterSeconds: 60 } });
    },
  };
});

const demoRoute = await import("@/app/api/analysis/demo/route");
const analysisRoute = await import("@/app/api/analysis/[id]/route");

function fakeDb() {
  const repositories: Row[] = [];
  const analyses: Row[] = [];
  let seq = 0;
  return {
    repositories,
    analyses,
    repository: {
      findFirst: async ({ where }: { where: Row }) => repositories.find((r) => r.userId === where.userId && r.source === where.source) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = { id: `repo${seq++}`, ...data };
        repositories.push(row);
        return { id: row.id };
      },
      update: async ({ where }: { where: { id: string } }) => ({ id: where.id }),
    },
    analysis: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: `an${seq++}`, status: "QUEUED", ...data };
        analyses.push(row);
        return { id: row.id, status: row.status };
      },
      update: async () => ({}),
      findFirst: async ({ where }: { where: { id: string; repository: { userId: string } } }) => {
        const a = analyses.find((x) => x.id === where.id);
        const repo = a && repositories.find((r) => r.id === a.repositoryId);
        return a && repo?.userId === where.repository.userId ? { ...a, repository: { id: repo.id, name: repo.name, owner: null, url: null, source: repo.source, branch: null } } : null;
      },
    },
  };
}

const ORIGIN = "http://localhost:3000";
const post = (headers: Record<string, string> = { origin: ORIGIN }) => demoRoute.POST(new NextRequest(`${ORIGIN}/api/analysis/demo`, { method: "POST", headers }), { params: Promise.resolve({}) });
const body = async (res: Response) => (await res.json()) as { success: boolean; data?: Row; error?: { code: string } };

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  db = fakeDb();
  state.db = db;
  state.user = { id: "u1", email: "u1@example.com", name: "User One" };
  state.enqueued = [];
  state.rateLimited = [];
  state.limitExceeded = false;
});

describe("POST /api/analysis/demo", () => {
  it("creates the user's demo repository once and queues an analysis of it", async () => {
    const first = await post();
    expect(first.status).toBe(202);
    const data = (await body(first)).data!;
    expect(data).toEqual({ analysisId: expect.any(String), status: "queued" });
    expect(db.repositories).toEqual([expect.objectContaining({ userId: "u1", source: "DEMO", name: "storefront-demo" })]);
    expect(state.enqueued).toEqual([data.analysisId]);

    // A second run re-uses the repository, so triage decisions carry over.
    await post();
    expect(db.repositories).toHaveLength(1);
    expect(db.analyses.map((a) => a.repositoryId)).toEqual([db.repositories[0]!.id, db.repositories[0]!.id]);
    expect(db.analyses.every((a) => a.mode === "LOCAL_ONLY")).toBe(true);
    expect(state.rateLimited).toEqual([
      ["analysis", "u1"],
      ["analysis", "u1"],
    ]);
  });

  it("requires a signed-in user and a same-origin request", async () => {
    state.user = null;
    expect((await post()).status).toBe(401);
    state.user = { id: "u1", email: "u1@example.com", name: "User One" };
    const crossSite = await post({ origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
    expect(await post({})).toHaveProperty("status", 403);
    expect(db.analyses).toEqual([]);
  });

  it("is rate limited like other analyses", async () => {
    state.limitExceeded = true;
    const res = await post();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(db.analyses).toEqual([]);
  });
});

describe("GET /api/analysis/:id", () => {
  it("returns the health score breakdown, and only to the owner", async () => {
    const created = (await body(await post())).data!;
    const breakdown = { version: "1.0", score: 58, grade: "D", dimensions: [] };
    Object.assign(db.analyses[0]!, { healthScore: 58, scoreBreakdown: breakdown });
    const get = () =>
      analysisRoute.GET(new NextRequest(`${ORIGIN}/api/analysis/${created.analysisId}`), { params: Promise.resolve({ id: created.analysisId as string }) });

    expect((await body(await get())).data).toMatchObject({ healthScore: 58, scoreBreakdown: breakdown, repository: { source: "DEMO" } });
    state.user = { id: "u2", email: "u2@example.com", name: "Other" };
    expect((await get()).status).toBe(404);
  });
});
