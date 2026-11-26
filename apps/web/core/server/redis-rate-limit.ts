import { getEnv } from "@hellobox/config";
import Redis from "ioredis";
import type { RateLimitStore } from "nezt";

let redis: Redis | undefined;

export const redisClient = () => (redis ??= new Redis(getEnv().REDIS_URL));

// Shared across instances and deploys, unlike nezt's in-memory default.
export const redisRateLimitStore: RateLimitStore = {
  async increment(key, windowMs) {
    const full = `ratelimit:${key}`;
    const [[, count], [, ttl]] = (await redisClient().multi().incr(full).pttl(full).exec()) as [[null, number], [null, number]];
    if (ttl < 0) await redisClient().pexpire(full, windowMs);
    return { count, resetAt: Date.now() + (ttl < 0 ? windowMs : ttl) };
  },
};
