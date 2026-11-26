import { redisClient } from "../redis-rate-limit";
import { SupportError } from "./http";

// Uploads open at once. Shared by every instance, and a slot nobody gave back (a crash)
// frees itself.
const PER_KEY = 2;
const IN_TOTAL = 10;
const TTL_MS = 5 * 60_000;

const TAKE = `
for i = 1, 2 do redis.call("zremrangebyscore", KEYS[i], "-inf", ARGV[1]) end
if redis.call("zcard", KEYS[1]) >= tonumber(ARGV[4]) then return 0 end
if redis.call("zcard", KEYS[2]) >= tonumber(ARGV[5]) then return 0 end
for i = 1, 2 do
  redis.call("zadd", KEYS[i], ARGV[2], ARGV[3])
  redis.call("pexpire", KEYS[i], ARGV[6])
end
return 1`;

export async function withUploadSlot<T>(keyId: string, run: () => Promise<T>, scope = "support"): Promise<T> {
  const redis = redisClient();
  const keys = [`${scope}:uploads:${keyId}`, `${scope}:uploads`] as const;
  const slot = crypto.randomUUID();
  const now = Date.now();
  const taken = await redis.eval(TAKE, 2, ...keys, now, now + TTL_MS, slot, PER_KEY, IN_TOTAL, TTL_MS);
  if (!taken) throw new SupportError(429, "rate_limited", "Too many uploads at once. Try again in a moment", { "Retry-After": "5" });
  try {
    return await run();
  } finally {
    await Promise.all(keys.map((key) => redis.zrem(key, slot))).catch(() => undefined);
  }
}
