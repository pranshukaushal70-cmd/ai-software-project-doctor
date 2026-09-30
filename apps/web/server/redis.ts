import "server-only";
import { Redis } from "ioredis";
import { createLogger } from "@pd/shared/logger";

const log = createLogger("redis");
const globalForRedis = globalThis as unknown as { __pdRedis?: Redis | null };

/** Minimum interval between repeated connection-error log lines. */
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Shared Redis connection, or null when REDIS_URL is not configured.
 *
 * The web app only issues short commands (rate limiting, enqueueing jobs), so
 * commands fail fast while Redis is unreachable instead of waiting in the
 * offline queue forever: the rate limiter then falls back to its in-memory
 * insurance limiter and enqueueing surfaces an error. (The worker's blocking
 * connection is configured separately with maxRetriesPerRequest: null, as BullMQ
 * requires for workers.)
 */
export function getRedis(): Redis | null {
  if (globalForRedis.__pdRedis === undefined) {
    const url = process.env.REDIS_URL;
    if (!url) {
      globalForRedis.__pdRedis = null;
    } else {
      const redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 5_000 });
      let lastErrorAt = 0;
      redis.on("error", (err) => {
        if (Date.now() - lastErrorAt < ERROR_LOG_INTERVAL_MS) return;
        lastErrorAt = Date.now();
        log.warn({ err: { message: err.message, code: (err as NodeJS.ErrnoException).code } }, "redis connection error");
      });
      globalForRedis.__pdRedis = redis;
    }
  }
  return globalForRedis.__pdRedis;
}
