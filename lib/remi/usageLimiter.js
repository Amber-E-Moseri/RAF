/**
 * Per-user usage limits for Remi chat and summary.
 *
 * Fixed-window counters, keyed by workspace + user, so a user's budget in one workspace never
 * covers another. State is in-process: it protects a single API instance. Multiple instances
 * would each enforce their own budget, so a shared store is needed before scaling out.
 */

const MAX_TRACKED_KEYS = 10_000;

export function createUsageLimiter({ windowMs, max }) {
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new Error('windowMs must be a positive integer');
  if (!Number.isInteger(max) || max <= 0) throw new Error('max must be a positive integer');

  const buckets = new Map();

  function prune(now) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }

  return {
    consume(key, now = Date.now()) {
      if (buckets.size >= MAX_TRACKED_KEYS) prune(now);

      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
      }

      if (bucket.count >= max) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
      }

      bucket.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    },
    reset() {
      buckets.clear();
    },
  };
}

export const remiUsageLimits = {
  chat: createUsageLimiter({ windowMs: 10 * 60 * 1000, max: 30 }),
  summary: createUsageLimiter({ windowMs: 60 * 60 * 1000, max: 20 }),
};

export function rateLimitedBody(retryAfterSeconds) {
  return {
    error: 'Too many Remi requests. Please try again shortly.',
    errorCode: 'RATE_LIMITED',
    retryAfterSeconds,
  };
}
