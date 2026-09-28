import "server-only";
import { RateLimiterMemory, RateLimiterRedis, RateLimiterRes, type RateLimiterAbstract } from "rate-limiter-flexible";
import { AppError } from "@pd/shared";
import { getRedis } from "./redis";

/** Budgets per key. Tuned for interactive use; adjust via code review, not env, to keep them auditable. */
const POLICIES = {
  login: { points: 10, duration: 15 * 60 },
  signup: { points: 5, duration: 60 * 60 },
  analysis: { points: 20, duration: 60 * 60 },
  upload: { points: 10, duration: 60 * 60 },
  ai: { points: 30, duration: 60 * 60 },
  report: { points: 30, duration: 60 * 60 },
} as const;

export type RateLimitPolicy = keyof typeof POLICIES;

const limiters = new Map<RateLimitPolicy, RateLimiterAbstract>();

function limiterFor(policy: RateLimitPolicy): RateLimiterAbstract {
  let limiter = limiters.get(policy);
  if (!limiter) {
    const redis = getRedis();
    const opts = { keyPrefix: `rl:${policy}`, ...POLICIES[policy] };
    limiter = redis
      ? new RateLimiterRedis({ storeClient: redis, insuranceLimiter: new RateLimiterMemory(opts), ...opts })
      : new RateLimiterMemory(opts);
    limiters.set(policy, limiter);
  }
  return limiter;
}

export async function rateLimit(policy: RateLimitPolicy, key: string): Promise<void> {
  try {
    await limiterFor(policy).consume(key);
  } catch (err) {
    if (err instanceof RateLimiterRes) {
      const retryAfterSeconds = Math.ceil(err.msBeforeNext / 1000);
      throw new AppError("RATE_LIMITED", "Too many requests. Please try again later.", { details: { retryAfterSeconds } });
    }
    throw err;
  }
}
