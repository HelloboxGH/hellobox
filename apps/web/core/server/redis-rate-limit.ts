import { getEnv } from "@hellobox/config";
import Redis from "ioredis";
import type { RateLimitStore } from "nezt";

let redis: Redis | undefined;

// Shared across instances and deploys, unlike nezt's in-memory default.
export const redisRateLimitStore: RateLimitStore = {
  async increment(key, windowMs) {
    redis ??= new Redis(getEnv().REDIS_URL);
    const full = `ratelimit:${key}`;
    const [[, count], [, ttl]] = (await redis.multi().incr(full).pttl(full).exec()) as [[null, number], [null, number]];
    if (ttl < 0) await redis.pexpire(full, windowMs);
    return { count, resetAt: Date.now() + (ttl < 0 ? windowMs : ttl) };
  },
};
