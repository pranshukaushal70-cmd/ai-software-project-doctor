import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ------------------------------------------------------------------ mocks: session + database

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "u1@example.com", name: "User One" } as { id: string; email: string; name: string } | null,
  db: null as unknown,
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

const triageRoute = await import("@/app/api/analysis/[id]/findings/[findingId]/triage/route");
const findingsRoute = await import("@/app/api/analysis/[id]/findings/route");

const ANALYSES = [
  { id: "an1", userId: "u1", repositoryId: "repo1", repository: {} },
  { id: "an2", userId: "u1", repositoryId: "repo1", repository: {} }, // a re-analysis of the same repository
  { id: "other", userId: "u2", repositoryId: "repo2", repository: {} },
];
const FINDINGS: Row[] = [
  { id: "f1", analysisId: "an1", fingerprint: "fp-fixture", ruleId: "secret/hardcoded-credential", file: { path: "test/security.test.ts", language: "typescript" } },
  { id: "f2", analysisId: "an1", fingerprint: "fp-real", ruleId: "secret/hardcoded-credential", file: { path: "src/config.ts", language: "typescript" } },
  { id: "g1", analysisId: "an2", fingerprint: "fp-fixture", ruleId: "secret/hardcoded-credential", file: { path: "test/security.test.ts", language: "typescript" } },
];

/** In-memory stand-in for the Prisma calls these routes make. */
function fakeDb() {
  const triages: Row[] = [];
  const calls: Record<string, unknown[]> = {};
  const record = (name: string, args: unknown) => (calls[name] ??= []).push(args);
  return {
    triages,
    calls,
    analysis: {
      findFirst: async ({ where }: { where: { id: string; repository: { userId: string } } }) =>
        ANALYSES.find((a) => a.id === where.id && a.userId === where.repository.userId) ?? null,
    },
    finding: {
      findFirst: async ({ where }: { where: { id: string; analysisId: string } }) => {
        record("finding.findFirst", where);
        const f = FINDINGS.find((x) => x.id === where.id && x.analysisId === where.analysisId);
        return f ? { fingerprint: f.fingerprint, ruleId: f.ruleId, file: { path: (f.file as Row).path } } : null;
      },
      count: async ({ where }: { where: Row }) => (record("finding.count", where), FINDINGS.filter((f) => f.analysisId === where.analysisId).length),
      findMany: async ({ where }: { where: Row }) => {
        record("finding.findMany", where);
        return FINDINGS.filter((f) => f.analysisId === where.analysisId).map((f) => ({ ...f, severity: "INFO", data: null }));
      },
      groupBy: async () => [],
    },
    findingTriage: {
      findMany: async ({ where }: { where: { repositoryId: string } }) =>
        triages.filter((t) => t.repositoryId === where.repositoryId).map(({ fingerprint, status, reason, updatedAt }) => ({ fingerprint, status, reason, updatedAt })),
      upsert: async (args: { where: { repositoryId_fingerprint: { repositoryId: string; fingerprint: string } }; create: Row; update: Row }) => {
        record("findingTriage.upsert", args);
        const key = args.where.repositoryId_fingerprint;
        const existing = triages.find((t) => t.repositoryId === key.repositoryId && t.fingerprint === key.fingerprint);
        const updatedAt = new Date("2026-10-02T12:00:00Z");
        if (existing) Object.assign(existing, args.update, { updatedAt });
        else triages.push({ ...args.create, updatedAt });
        const t = existing ?? triages.at(-1)!;
        return { status: t.status, reason: t.reason, updatedAt };
      },
      deleteMany: async ({ where }: { where: { repositoryId: string; fingerprint: string } }) => {
        record("findingTriage.deleteMany", where);
        const before = triages.length;
        for (let i = triages.length - 1; i >= 0; i--) {
          if (triages[i]!.repositoryId === where.repositoryId && triages[i]!.fingerprint === where.fingerprint) triages.splice(i, 1);
        }
        return { count: before - triages.length };
      },
    },
  };
}

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  state.user = { id: "u1", email: "u1@example.com", name: "User One" };
  db = fakeDb();
  state.db = db;
});

const ORIGIN = "http://localhost:3000";
const send = async (method: "PUT" | "DELETE", id: string, findingId: string, body?: unknown, headers: Record<string, string> = { origin: ORIGIN }) => {
  const req = new NextRequest(`${ORIGIN}/api/analysis/${id}/findings/${findingId}/triage`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const handler = method === "PUT" ? triageRoute.PUT : triageRoute.DELETE;
  const res = await handler(req, { params: Promise.resolve({ id, findingId }) });
  return { status: res.status, body: (await res.json()) as { success: boolean; data: Row; error: Row } };
};
const list = async (id: string, qs = "") => {
  const res = await findingsRoute.GET(new NextRequest(`${ORIGIN}/api/analysis/${id}/findings${qs}`), { params: Promise.resolve({ id }) });
  return (await res.json()) as { data: { findings: Array<Row & { triage: Row | null }> } };
};

describe("PUT/DELETE /api/analysis/:id/findings/:findingId/triage", () => {
  it("marks one finding, keyed by repository and fingerprint, recording rule, path and user", async () => {
    const { status, body } = await send("PUT", "an1", "f1", { status: "EXPECTED", reason: "  fake key in a security fixture  " });
    expect(status).toBe(200);
    expect(body.data.triage).toMatchObject({ status: "EXPECTED", reason: "fake key in a security fixture" });
    expect(db.triages).toEqual([
      expect.objectContaining({
        repositoryId: "repo1",
        fingerprint: "fp-fixture",
        ruleId: "secret/hardcoded-credential",
        path: "test/security.test.ts",
        status: "EXPECTED",
        createdById: "u1",
      }),
    ]);
  });

  it("updates an existing decision instead of duplicating it, and clears it", async () => {
    await send("PUT", "an1", "f1", { status: "EXPECTED" });
    await send("PUT", "an1", "f1", { status: "IGNORED" });
    expect(db.triages).toHaveLength(1);
    expect(db.triages[0]).toMatchObject({ status: "IGNORED", reason: null });
    expect((await send("DELETE", "an1", "f1")).body.data).toEqual({ cleared: true });
    expect(db.triages).toEqual([]);
    expect((await send("DELETE", "an1", "f1")).body.data).toEqual({ cleared: false });
  });

  it("follows the same finding into a re-analysis but never covers other findings", async () => {
    await send("PUT", "an1", "f1", { status: "EXPECTED" });
    const same = (await list("an2")).data.findings;
    expect(same.find((f) => f.id === "g1")!.triage).toMatchObject({ status: "EXPECTED" });
    const first = (await list("an1")).data.findings;
    expect(first.find((f) => f.id === "f2")!.triage).toBeNull();
  });

  it("keeps triaged findings in the list unless the caller asks to hide them", async () => {
    await send("PUT", "an1", "f1", { status: "IGNORED" });
    expect((await list("an1")).data.findings).toHaveLength(2);
    await list("an1", "?triage=untriaged");
    expect(db.calls["finding.findMany"]!.at(-1)).toMatchObject({ analysisId: "an1", fingerprint: { notIn: ["fp-fixture"] } });
  });

  it("requires a signed-in user and a same-origin request", async () => {
    state.user = null;
    expect((await send("PUT", "an1", "f1", { status: "EXPECTED" })).status).toBe(401);
    state.user = { id: "u1", email: "u1@example.com", name: "User One" };
    expect((await send("PUT", "an1", "f1", { status: "EXPECTED" }, {})).status).toBe(403);
    expect((await send("DELETE", "an1", "f1", undefined, { origin: "https://evil.example" })).status).toBe(403);
    expect(db.triages).toEqual([]);
  });

  it("answers 404 for another user's analysis and for findings outside the analysis", async () => {
    const other = await send("PUT", "other", "f1", { status: "EXPECTED" });
    expect(other.status).toBe(404);
    expect(other.body.error).toMatchObject({ code: "NOT_FOUND", message: "Analysis not found" });
    // f1 exists, but in analysis an1, not an2.
    const wrong = await send("PUT", "an2", "f1", { status: "EXPECTED" });
    expect(wrong.status).toBe(404);
    expect(wrong.body.error).toMatchObject({ code: "NOT_FOUND", message: "Finding not found" });
    expect(db.triages).toEqual([]);
  });

  it("validates the ids and the body", async () => {
    expect((await send("PUT", "an1", "../f1", { status: "EXPECTED" })).status).toBe(400);
    expect((await send("PUT", "an1", "f1", { status: "SUPPRESSED" })).status).toBe(400);
    expect((await send("PUT", "an1", "f1", { status: "EXPECTED", reason: "x".repeat(501) })).status).toBe(400);
    expect((await send("PUT", "an1", "f1", "{not json")).status).toBe(400);
    expect(db.triages).toEqual([]);
  });
});
