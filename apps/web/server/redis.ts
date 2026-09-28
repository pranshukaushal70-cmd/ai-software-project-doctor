import "server-only";
import { Redis } from "ioredis";

const globalForRedis = globalThis as unknown as { __pdRedis?: Redis | null };

/** Shared Redis connection, or null when REDIS_URL is not configured. */
export function getRedis(): Redis | null {
  if (globalForRedis.__pdRedis === undefined) {
    const url = process.env.REDIS_URL;
    globalForRedis.__pdRedis = url ? new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false }) : null;
  }
  return globalForRedis.__pdRedis;
}
