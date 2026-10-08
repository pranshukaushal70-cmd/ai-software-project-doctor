import "server-only";
import { getPrisma } from "@pd/db";
import { getRedis } from "../redis";

/**
 * Readiness of the web tier (Phase 10): used by container health checks, compose and
 * the end-to-end tests to know when the app can serve requests. It reports only
 * "ok"/"unavailable" per dependency, never connection strings or error messages.
 */

export type CheckState = "ok" | "unavailable";
export interface HealthReport {
  status: "ok" | "degraded";
  checks: { database: CheckState; redis: CheckState };
}

export interface HealthProbes {
  database: () => Promise<unknown>;
  /** null when Redis is not configured (the app then falls back to in-memory rate limiting and cannot enqueue). */
  redis: (() => Promise<unknown>) | null;
}

const CHECK_TIMEOUT_MS = 2_000;

async function probe(fn: () => Promise<unknown>): Promise<CheckState> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS);
      }),
    ]);
    return "ok";
  } catch {
    return "unavailable";
  } finally {
    clearTimeout(timer);
  }
}

export async function checkHealth(probes: HealthProbes = defaultProbes()): Promise<HealthReport> {
  const [database, redis] = await Promise.all([probe(probes.database), probes.redis ? probe(probes.redis) : Promise.resolve<CheckState>("unavailable")]);
  return { status: database === "ok" && redis === "ok" ? "ok" : "degraded", checks: { database, redis } };
}

function defaultProbes(): HealthProbes {
  const redis = getRedis();
  return {
    database: () => getPrisma().$queryRaw`SELECT 1`,
    redis: redis ? () => redis.ping() : null,
  };
}
