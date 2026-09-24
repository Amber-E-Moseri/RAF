import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { loadServerEnv, checkRuntimeRolePrivileges } from './lib/server/env.js';
import { initSentry, Sentry } from './lib/server/sentry.js';
import { createApiRouter } from './lib/server/routerLoader.js';
import { createServerDb } from './lib/server/db.js';
import { checkReadiness } from './lib/server/readinessHandler.js';
import { createFixedWindowRateLimiter } from './lib/server/rateLimit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { port, dbPath, persistenceDriver, postgresConnectionString, postgresSsl, authRequired, sentryDsn, allowedOrigins, supabaseUrl, supabaseAnonKey, rafAppUrl } = loadServerEnv({ cwd: __dirname });

initSentry(sentryDsn);

if (persistenceDriver === 'postgres') {
  await checkRuntimeRolePrivileges({ postgresConnectionString, authRequired });
}

const db = createServerDb({ persistenceDriver, dbPath, postgresConnectionString, postgresSsl });

// Dynamic import keeps @supabase/supabase-js out of the module graph when
// Supabase is not configured — test servers and local-auth deployments never
// load the package, avoiding a hard dependency on an optional credential.
const supabaseAuth = supabaseUrl && supabaseAnonKey
  ? await import('./lib/auth/supabaseAuth.js').then(({ createSupabaseAuth }) =>
      createSupabaseAuth({ url: supabaseUrl, anonKey: supabaseAnonKey, appUrl: rafAppUrl }))
  : null;

console.log(`[RAF] persistence: ${persistenceDriver}`);
console.log(`[RAF] supabase auth: ${supabaseAuth ? 'enabled' : 'disabled (local auth)'}`);

const app = express();

app.use((req, res, next) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const durationMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
    console.info(JSON.stringify({
      level: 'info',
      event: 'api_request',
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs,
      householdId: req.headers['x-household-id'] ?? req.headers['x-household_id'] ?? null,
    }));
  });
  next();
});

const allowedOriginsSet = new Set(allowedOrigins);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  const isLocalhost = origin && /^https?:\/\/localhost:\d+$/.test(origin);
  const isAllowed = origin && allowedOriginsSet.has(origin);

  if (isLocalhost || isAllowed) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }

  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Idempotency-Key, x-workspace-id, x-household-id, x-household_id');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  next();
});

const authRateLimitMax = Number.parseInt(process.env.RAF_AUTH_RATE_LIMIT_MAX ?? '20', 10);
const authLoginRateLimiter = createFixedWindowRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: authRateLimitMax,
  keyPrefix: 'auth-login',
});

const authSignupRateLimiter = createFixedWindowRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: authRateLimitMax,
  keyPrefix: 'auth-signup',
});

app.use('/api/v1/auth/login', authLoginRateLimiter);
app.use('/api/v1/auth/signup', authSignupRateLimiter);

app.use(express.json());
app.use(express.raw({
  type: (req) => {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    return contentType.startsWith('multipart/form-data') || contentType.startsWith('application/pdf');
  },
  limit: '10mb',
}));

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'raf-api',
  });
});

app.get('/api/v1/health', async (_req, res) => {
  const { status, body } = await checkReadiness(db);
  res.status(status).json(body);
});

const apiRootDir = path.join(__dirname, 'app', 'api', 'v1');
const aliases = [
  {
    path: '/allocation-categories',
    method: 'GET',
    file: path.join(apiRootDir, 'household', 'allocation-categories', 'route.js'),
  },
  {
    path: '/allocation-categories',
    method: 'PUT',
    file: path.join(apiRootDir, 'household', 'allocation-categories', 'route.js'),
  },
  {
    path: '/monthly-review',
    method: 'POST',
    file: path.join(apiRootDir, 'monthly-reviews', 'route.js'),
  },
  // Wave C Month Lifecycle endpoints
  {
    path: '/monthly-reviews/lifecycle',
    method: 'GET',
    file: path.join(apiRootDir, 'monthly-reviews', 'lifecycle', 'route.js'),
  },
  {
    path: '/monthly-reviews/lifecycle',
    method: 'POST',
    file: path.join(apiRootDir, 'monthly-reviews', 'lifecycle', 'route.js'),
  },
  {
    path: '/monthly-reviews/close-readiness',
    method: 'GET',
    file: path.join(apiRootDir, 'monthly-reviews', 'close-readiness', 'route.js'),
  },
  {
    path: '/monthly-reviews/close',
    method: 'POST',
    file: path.join(apiRootDir, 'monthly-reviews', 'close', 'route.js'),
  },
  {
    path: '/monthly-reviews/reopen',
    method: 'POST',
    file: path.join(apiRootDir, 'monthly-reviews', 'reopen', 'route.js'),
  },
  {
    path: '/monthly-reviews/buffer-disposition',
    method: 'POST',
    file: path.join(apiRootDir, 'monthly-reviews', 'buffer-disposition', 'route.js'),
  },
];

const apiRouter = await createApiRouter({
  apiRootDir,
  db,
  defaultHouseholdId: authRequired ? null : (db.defaultHouseholdId ?? null),
  aliases,
  supabaseAuth,
});

app.use('/api/v1', apiRouter);

app.use((req, res) => {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

Sentry.setupExpressErrorHandler(app);

app.use((error, _req, res, _next) => {
  const status = typeof error?.status === 'number' ? error.status : 500;
  console.error(JSON.stringify({
    level: 'error',
    event: 'api_error',
    status,
    message: error?.message ?? 'Internal Server Error',
  }));
  res.status(status).json({
    error: error?.message ?? 'Internal Server Error',
  });
});

app.listen(port, () => {
  console.log(`RAF API running on http://localhost:${port}`);
});
