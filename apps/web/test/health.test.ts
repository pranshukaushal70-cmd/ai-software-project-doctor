import { describe, expect, it } from "vitest";
import { checkHealth } from "@/server/services/health-service";

describe("health check", () => {
  it("is ok when the database and Redis answer", async () => {
    expect(await checkHealth({ database: async () => 1, redis: async () => "PONG" })).toEqual({ status: "ok", checks: { database: "ok", redis: "ok" } });
  });

  it("is degraded, without error details, when a dependency fails", async () => {
    const report = await checkHealth({
      database: async () => {
        throw new Error("connect ECONNREFUSED postgresql://doctor:hunter2@db:5432");
      },
      redis: async () => "PONG",
    });
    expect(report).toEqual({ status: "degraded", checks: { database: "unavailable", redis: "ok" } });
    expect(JSON.stringify(report)).not.toContain("hunter2");
  });

  it("treats a missing Redis configuration and a hanging dependency as unavailable", async () => {
    expect((await checkHealth({ database: async () => 1, redis: null })).checks.redis).toBe("unavailable");
    const hanging = await checkHealth({ database: () => new Promise(() => undefined), redis: async () => "PONG" });
    expect(hanging.checks.database).toBe("unavailable");
  }, 10_000);
});
