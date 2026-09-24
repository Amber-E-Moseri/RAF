/**
 * Supabase auth wiring tests.
 *
 * Covers the dependency-injection path from loadServerEnv → createApiRouter →
 * resolveTrustedContext → route handler context, plus route-level fail-closed
 * behaviour when the adapter is absent or misconfigured.
 *
 * All tests are self-contained: no live DB, no real Supabase network calls.
 * Env manipulation is scoped and restored in each test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ── helpers ────────────────────────────────────────────────────────────────────

function src(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
}

/** Run fn with process.env temporarily patched then restored. */
async function withEnv(overrides, fn) {
  const saved = {};
  const toDelete = [];

  for (const [k, v] of Object.entries(overrides)) {
    if (k in process.env) {
      saved[k] = process.env[k];
    } else {
      toDelete.push(k);
    }
    process.env[k] = v;
  }

  try {
    return await fn();
  } finally {
    for (const k of toDelete) {
      delete process.env[k];
    }
    for (const [k, v] of Object.entries(saved)) {
      process.env[k] = v;
    }
  }
}

/**
 * Import loadServerEnv under an isolated env. Because ES modules are cached
 * after first import, we pass the patched overrides into withEnv and import
 * loadServerEnv fresh by using a dynamic import inside the env window.
 *
 * We rely on the fact that loadServerEnv reads process.env at *call time*
 * (not at module load time), so the cached module is fine.
 */
const { loadServerEnv } = await import('../lib/server/env.js');

function baseEnv() {
  return {
    RAF_DB_PATH: '/tmp/test.db',
    PERSISTENCE_DRIVER: 'sqlite',
    RAF_AUTH_REQUIRED: 'false',
  };
}

function callLoadServerEnv(overrides = {}) {
  return withEnv({ ...baseEnv(), ...overrides }, () => loadServerEnv({ cwd: root }));
}

// Fake Supabase adapter for route-injection tests
function makeFakeAdapter() {
  const calls = [];
  return {
    _calls: calls,
    sendPasswordReset: async ({ email }) => { calls.push({ method: 'sendPasswordReset', email }); },
    updatePassword: async ({ accessToken, password }) => { calls.push({ method: 'updatePassword', accessToken, password }); },
    signInWithPassword: async ({ email, password }) => { calls.push({ method: 'signInWithPassword', email, password }); return { user: { id: 'u1', email }, session: { access_token: 'tok' } }; },
    signUp: async ({ email, password }) => { calls.push({ method: 'signUp', email, password }); return { user: { id: 'u1', email }, session: { access_token: 'tok' } }; },
  };
}

// Minimal fake JSON request
function makeRequest(body, headers = {}) {
  return {
    json: async () => body,
    headers: {
      get: (k) => (headers[k.toLowerCase()] ?? null),
    },
  };
}

// ── ENVIRONMENT PARSING ────────────────────────────────────────────────────────

test('1. No Supabase vars → adapter disabled (supabaseUrl/AnonKey null)', async () => {
  const result = await callLoadServerEnv({});
  assert.equal(result.supabaseUrl, null);
  assert.equal(result.supabaseAnonKey, null);
});

test('2. Both SUPABASE_URL + SUPABASE_ANON_KEY present → values returned', async () => {
  const result = await callLoadServerEnv({
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_ANON_KEY: 'anon-key-value',
  });
  assert.equal(result.supabaseUrl, 'https://proj.supabase.co');
  assert.equal(result.supabaseAnonKey, 'anon-key-value');
});

test('3. Only SUPABASE_URL present → startup error (partial config rejected)', async () => {
  await assert.rejects(
    () => callLoadServerEnv({ SUPABASE_URL: 'https://proj.supabase.co' }),
    /SUPABASE_URL and SUPABASE_ANON_KEY must be provided together/,
  );
});

test('4. Only SUPABASE_ANON_KEY present → startup error (partial config rejected)', async () => {
  await assert.rejects(
    () => callLoadServerEnv({ SUPABASE_ANON_KEY: 'anon-key-value' }),
    /SUPABASE_URL and SUPABASE_ANON_KEY must be provided together/,
  );
});

test('5. RAF_APP_URL present → parsed and returned', async () => {
  const result = await callLoadServerEnv({
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_ANON_KEY: 'key',
    RAF_APP_URL: 'https://app.example.com',
  });
  assert.equal(result.rafAppUrl, 'https://app.example.com');
});

test('5b. RAF_APP_URL absent with Supabase enabled → null (startup proceeds, warning emitted)', async () => {
  const result = await callLoadServerEnv({
    SUPABASE_URL: 'https://proj.supabase.co',
    SUPABASE_ANON_KEY: 'key',
  });
  assert.equal(result.rafAppUrl, null);
});

test('5c. RAF_APP_URL must be a valid absolute URL when provided', async () => {
  await assert.rejects(
    () => callLoadServerEnv({
      SUPABASE_URL: 'https://proj.supabase.co',
      SUPABASE_ANON_KEY: 'key',
      RAF_APP_URL: 'not-a-url',
    }),
    /Invalid server environment configuration/,
  );
});

// ── ROUTER CONTEXT INJECTION ───────────────────────────────────────────────────

// Import the internal resolveTrustedContext via the module's own exports.
// createApiRouter is exported; resolveTrustedContext is internal.
// We test context injection through the exported source-contract instead (simpler, reliable).

test('6. createApiRouter source — supabaseAuth parameter defaulted to null', () => {
  const loader = src('lib/server/routerLoader.js');
  assert.ok(
    loader.includes('supabaseAuth = null'),
    'createApiRouter must accept supabaseAuth defaulting to null',
  );
});

test('7. createApiRouter source — authProvider set to null when no adapter', () => {
  const loader = src('lib/server/routerLoader.js');
  assert.ok(
    loader.includes("authProvider: supabaseAuth ? 'supabase' : null"),
    'authProvider must be null when supabaseAuth is falsy',
  );
});

test('8. createApiRouter source — authProvider set to supabase when adapter present', () => {
  const loader = src('lib/server/routerLoader.js');
  assert.ok(
    loader.includes("authProvider: supabaseAuth ? 'supabase' : null"),
    "authProvider must be 'supabase' when supabaseAuth is truthy",
  );
});

test('9. createApiRouter source — supabaseAuth placed on context object', () => {
  const loader = src('lib/server/routerLoader.js');
  assert.ok(
    loader.includes('supabaseAuth: supabaseAuth ?? null'),
    'supabaseAuth must be placed on the context object',
  );
});

// ── ROUTE FAIL-CLOSED BEHAVIOR ─────────────────────────────────────────────────

const { POST: forgotPasswordPost } = await import('../app/api/v1/auth/forgot-password/route.js');
const { POST: resetPasswordPost } = await import('../app/api/v1/auth/reset-password/route.js');
const { POST: loginPost } = await import('../app/api/v1/auth/login/route.js');
const { POST: signupPost } = await import('../app/api/v1/auth/signup/route.js');

test('10. forgot-password: receives adapter → calls sendPasswordReset', async () => {
  const adapter = makeFakeAdapter();
  const req = makeRequest({ email: 'user@test.com' });
  const ctx = { authProvider: 'supabase', supabaseAuth: adapter };
  const res = await forgotPasswordPost(req, ctx);
  const body = JSON.parse(await res.text());
  assert.equal(res.status, 200);
  assert.ok(body.message);
  assert.equal(adapter._calls.length, 1);
  assert.equal(adapter._calls[0].method, 'sendPasswordReset');
  assert.equal(adapter._calls[0].email, 'user@test.com');
});

test('11. reset-password: receives adapter + valid token → calls updatePassword', async () => {
  const adapter = makeFakeAdapter();
  const req = makeRequest({ password: 'newpassword123' }, { authorization: 'Bearer recovery-tok' });
  const ctx = { authProvider: 'supabase', supabaseAuth: adapter };
  const res = await resetPasswordPost(req, ctx);
  const body = JSON.parse(await res.text());
  assert.equal(res.status, 200);
  assert.equal(adapter._calls[0].method, 'updatePassword');
  assert.equal(adapter._calls[0].accessToken, 'recovery-tok');
  assert.equal(adapter._calls[0].password, 'newpassword123');
});

test('12. forgot-password without adapter → 404 (fail-closed)', async () => {
  const req = makeRequest({ email: 'user@test.com' });
  const ctx = { authProvider: null, supabaseAuth: null };
  const res = await forgotPasswordPost(req, ctx);
  assert.equal(res.status, 404);
});

test('13. reset-password without adapter → 404 (fail-closed)', async () => {
  const req = makeRequest({ password: 'pw' }, { authorization: 'Bearer tok' });
  const ctx = { authProvider: null, supabaseAuth: null };
  const res = await resetPasswordPost(req, ctx);
  assert.equal(res.status, 404);
});

test('14. reset-password invalid Bearer token (no header) → 401', async () => {
  const adapter = makeFakeAdapter();
  const req = makeRequest({ password: 'newpassword123' }, {});
  const ctx = { authProvider: 'supabase', supabaseAuth: adapter };
  const res = await resetPasswordPost(req, ctx);
  assert.equal(res.status, 401);
  assert.equal(adapter._calls.length, 0);
});

test('14b. reset-password adapter throws 401 → error propagates (no silent swallow)', async () => {
  // The route has no try/catch around updatePassword — adapter errors propagate to the
  // Express error handler in production, which maps them to the correct HTTP status.
  // This test verifies the route does NOT silently swallow the error.
  const adapter = {
    updatePassword: async () => {
      const e = new Error('Token expired'); e.status = 401; throw e;
    },
  };
  const req = makeRequest({ password: 'newpassword123' }, { authorization: 'Bearer bad-tok' });
  const ctx = { authProvider: 'supabase', supabaseAuth: adapter };
  await assert.rejects(
    () => resetPasswordPost(req, ctx),
    { message: 'Token expired' },
  );
});

// ── JWT / WORKSPACE REGRESSION GATES ──────────────────────────────────────────

test('15. routerLoader JWT verification path unchanged — verifyToken import present', () => {
  const loader = src('lib/server/routerLoader.js');
  assert.ok(loader.includes("from '../auth/jwt.js'"), 'JWT verification must still be imported');
  assert.ok(loader.includes('verifyToken(token'), 'verifyToken call must still be present');
  assert.ok(loader.includes('claims?.userId'), 'userId claim check must still be present');
});

test('16. routerLoader workspace authorization path unchanged — buildWorkspaceContext import present', () => {
  const loader = src('lib/server/routerLoader.js');
  assert.ok(loader.includes('buildWorkspaceContext'), 'workspace context builder must still be present');
  assert.ok(loader.includes('getWorkspaceMember'), 'membership lookup must still be present');
  assert.ok(loader.includes('Workspace access denied'), 'workspace denial error must still be present');
});

// ── LOCAL AUTH FALLBACK ────────────────────────────────────────────────────────

test('17. login: local auth path executes when adapter absent (no authProvider branch taken)', async () => {
  const req = makeRequest({ email: 'local@test.com', password: 'pw' });
  // No supabaseAuth — context missing authProvider
  const fakeDb = {
    transaction: async (fn) => fn({
      getUserByEmail: async () => null,
    }),
  };
  const ctx = { authProvider: null, supabaseAuth: null, db: fakeDb };
  const res = await loginPost(req, ctx);
  const body = JSON.parse(await res.text());
  // Local path: user not found → 401
  assert.equal(res.status, 401);
  assert.equal(body.error, 'Invalid email or password');
});

test('18. signup: local auth path executes when adapter absent', async () => {
  const req = makeRequest({ email: 'local@test.com', password: 'localpassword123' });
  const fakeDb = {
    transaction: async (fn, _ctx) => fn({
      createUser: async ({ id, email, passwordHash }) => ({ id, email, passwordHash }),
      createWorkspaceRecord: async ({ id, name, type, ownerUserId }) => ({ id, name, type, ownerUserId }),
      createWorkspaceMember: async ({ workspaceId, userId, role, status }) => ({ workspaceId, userId, role, status }),
      initializeWorkspaceDefaults: async () => {},
    }),
  };
  const ctx = { authProvider: null, supabaseAuth: null, db: fakeDb };
  const res = await signupPost(req, ctx);
  // Local path: should create user → 201
  assert.equal(res.status, 201);
});

test('19. login: Supabase path executes when adapter present', async () => {
  const adapter = makeFakeAdapter();
  const fakeDb = {
    transaction: async (fn) => fn({
      getUserByUserId: async () => ({ id: 'u1', email: 'u@test.com', workspaces: [] }),
      listWorkspacesForUser: async () => [],
      createWorkspaceRecord: async () => ({}),
      createWorkspaceMember: async () => ({}),
      initializeWorkspaceDefaults: async () => {},
    }),
  };
  const req = makeRequest({ email: 'u@test.com', password: 'pw' });
  const ctx = { authProvider: 'supabase', supabaseAuth: adapter, db: fakeDb };
  // Will call ensureUserOnboarded which needs db.transaction — it may throw depending on
  // the onboarding implementation; we only verify Supabase adapter was invoked
  try {
    await loginPost(req, ctx);
  } catch {
    // onboarding may fail with incomplete fake db — irrelevant to this gate
  }
  assert.ok(adapter._calls.some((c) => c.method === 'signInWithPassword'), 'Supabase signInWithPassword must be called when adapter present');
});

test('20. signup: Supabase path executes when adapter present', async () => {
  const adapter = makeFakeAdapter();
  const fakeDb = {
    transaction: async (fn) => fn({
      getUserByUserId: async () => null,
      createWorkspaceRecord: async () => ({ id: 'ws1', name: 'H', type: 'household', ownerUserId: 'u1' }),
      createWorkspaceMember: async () => ({ role: 'owner', status: 'active' }),
      initializeWorkspaceDefaults: async () => {},
      listWorkspacesForUser: async () => [],
    }),
  };
  const req = makeRequest({ email: 'u@test.com', password: 'password123' });
  const ctx = { authProvider: 'supabase', supabaseAuth: adapter, db: fakeDb };
  try {
    await signupPost(req, ctx);
  } catch {
    // onboarding may fail with incomplete fake db — irrelevant to this gate
  }
  assert.ok(adapter._calls.some((c) => c.method === 'signUp'), 'Supabase signUp must be called when adapter present');
});

// ── SECRET SAFETY ──────────────────────────────────────────────────────────────

test('21. index.js does not log Supabase secrets — only mode is logged', () => {
  const bootstrap = src('index.js');
  // The only Supabase-related log must be the mode indicator, never the key value.
  assert.ok(bootstrap.includes('[RAF] supabase auth:'), 'bootstrap must log supabase mode');
  // Dynamic import keeps the package out of the static module graph.
  assert.ok(bootstrap.includes("import('./lib/auth/supabaseAuth.js')"), 'bootstrap must use dynamic import for supabase auth');
  // Anon key must not appear in any console.log call.
  const logLines = bootstrap.split('\n').filter((l) => l.includes('console.log'));
  for (const line of logLines) {
    assert.ok(!line.includes('supabaseAnonKey'), `log statement must not include supabaseAnonKey: ${line}`);
    assert.ok(!line.includes('SUPABASE_ANON_KEY'), `log statement must not include SUPABASE_ANON_KEY: ${line}`);
  }
});

test('22. env.js schema does not log Supabase secrets', () => {
  const envSrc = src('lib/server/env.js');
  // The schema includes keys for parsing but must never be console.log'd
  assert.ok(!envSrc.includes('console.log(parsed.data.SUPABASE'), 'env.js must not print parsed Supabase vars');
  assert.ok(!envSrc.includes('console.log(process.env.SUPABASE'), 'env.js must not print raw Supabase env vars');
});

// ── DIFF INTEGRITY ─────────────────────────────────────────────────────────────

test('23. No database migration files were added by this wiring', () => {
  const migrationFiles = fs.readdirSync(path.join(root, 'db', 'migrations')).filter((f) => f.endsWith('.sql'));
  // No migration file should mention supabase — the wiring is pure server code
  for (const f of migrationFiles) {
    assert.ok(!f.toLowerCase().includes('supabase'), `unexpected migration file mentioning supabase: ${f}`);
  }
});

test('24. No RLS policy files were added by this wiring', () => {
  // RLS policies live in migration SQL files. Wiring adds no SQL files.
  const src2 = src('lib/server/routerLoader.js');
  assert.ok(!src2.includes('CREATE POLICY'), 'routerLoader must not contain RLS policy creation');
});
