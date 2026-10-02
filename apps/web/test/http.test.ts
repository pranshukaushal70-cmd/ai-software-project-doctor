import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "@pd/shared";
import { ok, readJson, route } from "@/server/http";

const ctx = { params: Promise.resolve({}) };

function request(method: string, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost:3000/api/test", { method, headers });
}

describe("route wrapper", () => {
  it("wraps successful responses and adds a request id", async () => {
    const res = await route(async () => ok({ hello: "world" }))(request("GET"), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { hello: "world" } });
    expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects cross-origin mutating requests (CSRF)", async () => {
    const handler = route(async () => ok({}));
    const res = await handler(request("POST", { origin: "https://evil.example" }), ctx);
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect((await handler(request("POST"), ctx)).status).toBe(403);
    expect((await handler(request("POST", { origin: "http://localhost:3000" }), ctx)).status).toBe(200);
  });

  it("maps AppError to its status and code", async () => {
    const res = await route(async () => {
      throw new AppError("NOT_FOUND", "Analysis not found");
    })(request("GET"), ctx);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: { code: "NOT_FOUND", message: "Analysis not found" } });
    expect(body.error.requestId).toBe(res.headers.get("x-request-id"));
  });

  it("answers a malformed JSON body with 400, not 500", async () => {
    const handler = route(async (req) => ok(await readJson(req)));
    const post = (body: string) =>
      new NextRequest("http://localhost:3000/api/test", {
        method: "POST",
        headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        body,
      });
    const bad = await handler(post("{not json"), ctx);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatchObject({ code: "VALIDATION_ERROR", message: "Request body must be valid JSON" });
    const good = await handler(post('{"a":1}'), ctx);
    expect(await good.json()).toEqual({ success: true, data: { a: 1 } });
  });

  it("maps zod errors to VALIDATION_ERROR", async () => {
    const res = await route(async () => {
      z.object({ url: z.string() }).parse({});
      return ok({});
    })(request("GET"), ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details[0].path).toBe("url");
  });

  it("hides internal error details", async () => {
    // Obviously fake test fixture (.invalid host, self-describing password); it stands in for a real DATABASE_URL.
    const FAKE_DB_URL = "postgres://test-user:not-a-real-password@db.invalid/app";
    const res = await route(async () => {
      throw new Error(`connection string ${FAKE_DB_URL} leaked`);
    })(request("GET"), ctx);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("not-a-real-password");
    expect(JSON.parse(text).error).toMatchObject({ code: "INTERNAL_ERROR", message: "An unexpected error occurred" });
  });

  it("sets Retry-After for rate-limited responses", async () => {
    const res = await route(async () => {
      throw new AppError("RATE_LIMITED", "slow down", { details: { retryAfterSeconds: 42 } });
    })(request("GET"), ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
  });
});
