import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError } from "@pd/shared";
import { ok, route } from "@/server/http";

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
    const res = await route(async () => {
      throw new Error("connection string postgres://user:pw@db leaked");
    })(request("GET"), ctx);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("postgres://");
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
