import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeReportsDb } from "../../../packages/reports/test/fake-db";
import { FAKE_KEY, world } from "../../../packages/reports/test/fixtures";

// ------------------------------------------------------------------ mocks: session, database, rate limit

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com", name: "User One" } as { id: string; email: string; name: string } | null,
  db: null as unknown,
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
vi.mock("@pd/db", async (orig) => ({ ...(await orig<typeof import("@pd/db")>()), getPrisma: () => state.db }));
vi.mock("@/server/rate-limit", async () => {
  const { AppError } = await import("@pd/shared");
  return {
    rateLimit: async (policy: string, key: string) => {
      state.rateLimited.push([policy, key]);
      if (state.limitExceeded) throw new AppError("RATE_LIMITED", "Too many requests. Please try again later.");
    },
  };
});

const reportsRoute = await import("@/app/api/reports/route");
const latestRoute = await import("@/app/api/reports/latest/route");
const reportRoute = await import("@/app/api/reports/[id]/route");
const exportRoute = await import("@/app/api/reports/[id]/export/route");

beforeEach(() => {
  state.db = fakeReportsDb(world());
  state.user = { id: "u1", email: "u1@example.com", name: "User One" };
  state.rateLimited = [];
  state.limitExceeded = false;
});

const ORIGIN = "http://localhost:3000";
type Handler = (req: NextRequest, ctx: { params: Promise<any> }) => Promise<Response>;
async function call(handler: Handler, url: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; id?: string } = {}) {
  const req = new NextRequest(`${ORIGIN}${url}`, {
    method: init.method ?? "GET",
    headers: init.headers ?? (init.method === "POST" ? { origin: ORIGIN, "content-type": "application/json" } : {}),
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
  return handler(req, { params: Promise.resolve({ id: init.id ?? "" }) });
}
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as { data?: any; error?: { code: string; message: string; details?: unknown } } });
const create = async (body: unknown, headers?: Record<string, string>) => json(await call(reportsRoute.POST, "/api/reports", { method: "POST", body, headers }));
const list = async (qs = "") => json(await call(reportsRoute.GET, `/api/reports${qs}`));
const get = async (id: string) => json(await call(reportRoute.GET, `/api/reports/${id}`, { id }));

describe("POST /api/reports", () => {
  it("generates a report from stored data, and returns the existing one when nothing changed", async () => {
    const first = await create({ type: "RUN", subjectId: "run-passed" });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ created: true, type: "RUN", status: "COMPLETE", outcome: "TESTS_PASSED", runId: "run-passed", planId: "p1", analysisId: "an1", version: 1 });
    expect(first.body.data.data.chain.at(-1)).toEqual({ step: "result", state: "passed", detail: "tests passed" });
    expect(state.rateLimited).toEqual([["report", "u1"]]);
    const again = await create({ type: "RUN", subjectId: "run-passed" });
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ created: false, id: first.body.data.id });
  });

  it("validates input", async () => {
    expect((await create({ type: "RUN" })).status).toBe(400);
    expect((await create({ type: "REPO", subjectId: "an1" })).status).toBe(400);
    expect((await create({ type: "RUN", subjectId: "bad id!" })).status).toBe(400);
    expect((await create({ type: "RUN", subjectId: "run-passed", extra: 1 })).status).toBe(400);
    expect((await create("{not json")).status).toBe(400);
  });

  it("returns 404 for missing subjects and other users' subjects, and enforces auth, Origin and the rate limit", async () => {
    expect((await create({ type: "RUN", subjectId: "missing" })).status).toBe(404);
    expect((await create({ type: "RUN", subjectId: "run-other" })).status).toBe(404);
    expect((await create({ type: "ANALYSIS", subjectId: "an-other" })).status).toBe(404);
    state.user = null;
    expect((await create({ type: "ANALYSIS", subjectId: "an1" })).status).toBe(401);
    state.user = { id: "u1", email: "", name: "" };
    expect((await create({ type: "ANALYSIS", subjectId: "an1" }, { "content-type": "application/json" })).status).toBe(403);
    expect((await create({ type: "ANALYSIS", subjectId: "an1" }, { origin: "https://evil.example", "content-type": "application/json" })).status).toBe(403);
    state.limitExceeded = true;
    expect((await create({ type: "ANALYSIS", subjectId: "an1" })).status).toBe(429);
    expect((state.db as any).reports).toEqual([]);
  });
});

describe("reading reports", () => {
  it("lists without snapshots, filters and paginates", async () => {
    for (const id of ["run-passed", "run-failed", "run-untested"]) await create({ type: "RUN", subjectId: id });
    await create({ type: "ANALYSIS", subjectId: "an1" });
    const all = await list();
    expect(all.body.data).toMatchObject({ total: 4, page: 1, pageSize: 20, pages: 1 });
    expect(all.body.data.items[0]).not.toHaveProperty("data");
    expect((await list("?type=RUN&outcome=FAILED")).body.data.items.map((i: any) => i.runId)).toEqual(["run-failed"]);
    expect((await list("?analysisId=an1")).body.data.total).toBe(4);
    expect((await list("?repositoryId=r1&status=COMPLETE")).body.data.total).toBe(4);
    expect((await list("?page=2&pageSize=3")).body.data.items).toHaveLength(1);
    for (const bad of ["?pageSize=500", "?page=0", "?type=nope", "?runId=bad id", "?unknown=1"]) expect((await list(bad)).status).toBe(400);
  });

  it("returns one report, the latest for a subject, and nothing of anyone else's", async () => {
    const id = (await create({ type: "PLAN", subjectId: "p1" })).body.data.id;
    const one = await get(id);
    expect(one.body.data).toMatchObject({ id, type: "PLAN", data: { plan: { approval: { state: "approved" } } } });
    const latest = await json(await call(latestRoute.GET, "/api/reports/latest?type=PLAN&subjectId=p1"));
    expect(latest.body.data.id).toBe(id);
    expect((await json(await call(latestRoute.GET, "/api/reports/latest?type=RUN&subjectId=run-passed"))).body.data).toBeNull();
    expect((await json(await call(latestRoute.GET, "/api/reports/latest?type=RUN"))).status).toBe(400);

    state.user = { id: "u2", email: "", name: "" };
    expect((await get(id)).status).toBe(404);
    expect((await list()).body.data.total).toBe(0);
    expect((await json(await call(latestRoute.GET, "/api/reports/latest?type=PLAN&subjectId=p1"))).body.data).toBeNull();
    expect((await json(await call(exportRoute.GET, `/api/reports/${id}/export`, { id }))).status).toBe(404);
    state.user = null;
    expect((await get(id)).status).toBe(401);
    expect((await list()).status).toBe(401);
    state.user = { id: "u1", email: "", name: "" };
    expect((await get("missing")).status).toBe(404);
    expect((await get("bad id!")).status).toBe(400);
  });

  it("exports Markdown (escaped) and JSON as attachments, without secrets", async () => {
    const id = (await create({ type: "RUN", subjectId: "run-failed-tests" })).body.data.id;
    const md = await call(exportRoute.GET, `/api/reports/${id}/export`, { id });
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(md.headers.get("content-disposition")).toBe(`attachment; filename="report-${id}.md"`);
    expect(md.headers.get("cache-control")).toBe("private, no-store");
    const text = await md.text();
    expect(text).toMatch(/^# Run report: /);
    expect(text).not.toMatch(/<script>|<img/);
    expect(text).not.toContain(FAKE_KEY);
    const js = await call(exportRoute.GET, `/api/reports/${id}/export?format=json`, { id });
    expect(js.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = JSON.parse(await js.text());
    expect(body).toMatchObject({ id, outcome: "TESTS_FAILED", data: { version: 1 } });
    expect(JSON.stringify(body)).not.toContain(FAKE_KEY);
    expect((await json(await call(exportRoute.GET, `/api/reports/${id}/export?format=pdf`, { id }))).status).toBe(400);
  });
});
