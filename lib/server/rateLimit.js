const DEFAULT_KEY = 'global';

function clientIp(req) {
  return req.ip
    ?? req.socket?.remoteAddress
    ?? req.connection?.remoteAddress
    ?? DEFAULT_KEY;
}

export function createFixedWindowRateLimiter({
  windowMs,
  max,
  keyPrefix,
  keyGenerator = clientIp,
  message = 'Too many requests. Please try again later.',
  // When true, only responses with status >= 400 consume the budget (used for
  // per-account login limiting, so legitimate repeated logins are never throttled).
  countFailuresOnly = false,
}) {
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new Error('Rate limiter windowMs must be a positive integer.');
  }

  if (!Number.isInteger(max) || max <= 0) {
    throw new Error('Rate limiter max must be a positive integer.');
  }

  const store = new Map();

  return function fixedWindowRateLimiter(req, res, next) {
    const now = Date.now();
    const rawKey = keyGenerator(req);
    if (rawKey === null) {
      // No usable identifier (e.g. no email in body): this limiter does not apply.
      next();
      return;
    }
    const key = `${keyPrefix}:${rawKey ?? DEFAULT_KEY}`;
    const existing = store.get(key);
    const bucket = existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + windowMs };

    if (countFailuresOnly) {
      if (!existing || existing.resetAt <= now) store.set(key, bucket);
      if (bucket.count >= max) {
        const retry = Math.max(Math.ceil((bucket.resetAt - now) / 1000), 0);
        res.setHeader('Retry-After', String(retry));
        res.status(429).json({ error: message });
        return;
      }
      res.on('finish', () => {
        if (res.statusCode >= 400 && res.statusCode !== 429) bucket.count += 1;
      });
      next();
      return;
    }

    bucket.count += 1;
    store.set(key, bucket);

    const remaining = Math.max(max - bucket.count, 0);
    const resetSeconds = Math.max(Math.ceil((bucket.resetAt - now) / 1000), 0);

    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (bucket.count > max) {
      res.setHeader('Retry-After', String(resetSeconds));
      res.status(429).json({ error: message });
      return;
    }

    next();
  };
}

/**
 * Account identifier for per-account auth limiting: the normalised email from the
 * (already parsed) JSON body, or null when absent so only the IP limiter applies.
 */
export function accountKey(req) {
  const email = req.body?.email;
  if (typeof email !== 'string') return null;
  const normalised = email.trim().toLowerCase();
  return normalised ? normalised.slice(0, 254) : null;
}

/**
 * Parse RAF_TRUST_PROXY into an Express `trust proxy` value.
 *
 * Only a hop COUNT (or false) is accepted — never `true`, which would trust the
 * entire X-Forwarded-For chain and let any client choose its own rate-limit key.
 * Default: 1 hop in production (Render's load balancer), otherwise false.
 */
export function parseTrustProxy(raw, nodeEnv) {
  const value = raw == null || String(raw).trim() === ''
    ? (nodeEnv === 'production' ? '1' : 'false')
    : String(raw).trim().toLowerCase();
  if (value === 'false' || value === '0') return false;
  if (/^[1-9]\d?$/.test(value)) return Number(value);
  throw new Error(`Invalid RAF_TRUST_PROXY "${raw}": use a hop count such as 1, or false. "true" is not allowed.`);
}

/**
 * Build the auth limiter chain: an IP limiter (real client IP, per trust-proxy
 * config) plus per-account limiters keyed by email. Order matters: body must be
 * parsed before these run.
 */
export function createAuthRateLimiters({ ipMax = 20, accountMax = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const ip = (keyPrefix) => createFixedWindowRateLimiter({ windowMs, max: ipMax, keyPrefix });
  return {
    login: [
      ip('auth-login'),
      createFixedWindowRateLimiter({ windowMs, max: accountMax, keyPrefix: 'auth-login-acct', keyGenerator: accountKey, countFailuresOnly: true }),
    ],
    signup: [
      ip('auth-signup'),
      createFixedWindowRateLimiter({ windowMs, max: accountMax, keyPrefix: 'auth-signup-acct', keyGenerator: accountKey }),
    ],
    forgotPassword: [
      ip('auth-forgot-password'),
      createFixedWindowRateLimiter({ windowMs, max: Math.min(accountMax, 5), keyPrefix: 'auth-forgot-acct', keyGenerator: accountKey }),
    ],
    resetPassword: [ip('auth-reset-password')],
  };
}
