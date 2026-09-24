import test from 'node:test';
import assert from 'node:assert/strict';

import { POST as forgotPassword } from '../app/api/v1/auth/forgot-password/route.js';
import { POST as resetPassword } from '../app/api/v1/auth/reset-password/route.js';
import { createInMemoryDb } from '../lib/server/inMemoryDb.js';

function jsonRequest(pathname, body, headers = {}) {
  return new Request(`http://localhost/api/v1${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function createFakeSupabaseAuth() {
  const calls = { passwordReset: [], updatePassword: [] };
  return {
    calls,
    async sendPasswordReset({ email }) {
      calls.passwordReset.push(email);
    },
    async updatePassword({ accessToken, password }) {
      calls.updatePassword.push({ accessToken, password });
      return { user: { id: 'fake-user-id' } };
    },
  };
}

function supabaseContext(supabaseAuth) {
  return { db: createInMemoryDb(), authProvider: 'supabase', supabaseAuth };
}

function jwtContext() {
  return { db: createInMemoryDb(), authProvider: 'jwt' };
}

// ── Forgot-password ────────────────────────────────────────────────────────

test('forgot-password: non-supabase auth (native) returns neutral 200', async () => {
  const res = await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'x@example.com' }),
    jwtContext(),
  );
  // Track A native implementation handles all auth providers; always returns
  // the neutral 200 response to prevent account enumeration.
  assert.equal(res.status, 200);
});

test('forgot-password: missing email returns 400', async () => {
  const res = await forgotPassword(
    jsonRequest('/auth/forgot-password', {}),
    supabaseContext(createFakeSupabaseAuth()),
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
});

test('forgot-password: non-string email returns 400', async () => {
  const res = await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 42 }),
    supabaseContext(createFakeSupabaseAuth()),
  );
  assert.equal(res.status, 400);
});

test('forgot-password: valid email returns 200 with neutral message', async () => {
  const auth = createFakeSupabaseAuth();
  const res = await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'amber@example.com' }),
    supabaseContext(auth),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.message);
  assert.equal(auth.calls.passwordReset.length, 1);
  assert.equal(auth.calls.passwordReset[0], 'amber@example.com');
});

test('forgot-password: response does not confirm whether account exists (user enumeration protection)', async () => {
  const auth = createFakeSupabaseAuth();
  const validRes = await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'real@example.com' }),
    supabaseContext(auth),
  );
  const validBody = await validRes.json();

  const auth2 = createFakeSupabaseAuth();
  const noAccountRes = await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'nobody@example.com' }),
    supabaseContext(auth2),
  );
  const noAccountBody = await noAccountRes.json();

  assert.equal(validRes.status, noAccountRes.status);
  assert.equal(validBody.message, noAccountBody.message);
});

test('forgot-password: invalid JSON body returns 400', async () => {
  const res = await forgotPassword(
    new Request('http://localhost/api/v1/auth/forgot-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    }),
    supabaseContext(createFakeSupabaseAuth()),
  );
  assert.equal(res.status, 400);
});

// ── Reset-password ─────────────────────────────────────────────────────────

test('reset-password: non-supabase auth with invalid token returns 401', async () => {
  const res = await resetPassword(
    jsonRequest('/auth/reset-password', { password: 'NewPass123!' }, { authorization: 'Bearer tok' }),
    jwtContext(),
  );
  // Track A native implementation: token is not in DB → 401 (not 404).
  assert.equal(res.status, 401);
});

test('reset-password: missing authorization header returns 401', async () => {
  const res = await resetPassword(
    jsonRequest('/auth/reset-password', { password: 'NewPass123!' }),
    supabaseContext(createFakeSupabaseAuth()),
  );
  assert.equal(res.status, 401);
});

test('reset-password: non-Bearer authorization returns 401', async () => {
  const res = await resetPassword(
    jsonRequest('/auth/reset-password', { password: 'NewPass123!' }, { authorization: 'Basic dXNlcjpwYXNz' }),
    supabaseContext(createFakeSupabaseAuth()),
  );
  assert.equal(res.status, 401);
});

test('reset-password: missing password returns 400', async () => {
  const res = await resetPassword(
    jsonRequest('/auth/reset-password', {}, { authorization: 'Bearer valid-access' }),
    supabaseContext(createFakeSupabaseAuth()),
  );
  assert.equal(res.status, 400);
});

test('reset-password: password shorter than 8 chars returns 400', async () => {
  const res = await resetPassword(
    jsonRequest('/auth/reset-password', { password: 'short' }, { authorization: 'Bearer valid-access' }),
    supabaseContext(createFakeSupabaseAuth()),
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
});

test('reset-password: exactly 8 chars is accepted', async () => {
  const auth = createFakeSupabaseAuth();
  const res = await resetPassword(
    jsonRequest('/auth/reset-password', { password: '12345678' }, { authorization: 'Bearer valid-access' }),
    supabaseContext(auth),
  );
  assert.equal(res.status, 200);
  assert.equal(auth.calls.updatePassword.length, 1);
  assert.equal(auth.calls.updatePassword[0].password, '12345678');
});

test('reset-password: valid request calls updatePassword with correct args', async () => {
  const auth = createFakeSupabaseAuth();
  const res = await resetPassword(
    jsonRequest('/auth/reset-password', { password: 'NewStrongPass123!' }, { authorization: 'Bearer my-token' }),
    supabaseContext(auth),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(auth.calls.updatePassword, [{ accessToken: 'my-token', password: 'NewStrongPass123!' }]);
});

test('reset-password: does not log password (updatePassword receives password, not a logged value)', async () => {
  const logged = [];
  const origLog = console.log;
  const origError = console.error;
  const origInfo = console.info;
  console.log = (...args) => logged.push(args.join(' '));
  console.error = (...args) => logged.push(args.join(' '));
  console.info = (...args) => logged.push(args.join(' '));

  const auth = createFakeSupabaseAuth();
  await resetPassword(
    jsonRequest('/auth/reset-password', { password: 'SecretPassword99!' }, { authorization: 'Bearer tok' }),
    supabaseContext(auth),
  );

  console.log = origLog;
  console.error = origError;
  console.info = origInfo;

  for (const line of logged) {
    assert.ok(!line.includes('SecretPassword99!'), `Password leaked in log: ${line}`);
  }
});

test('reset-password: invalid JSON body returns 400', async () => {
  const res = await resetPassword(
    new Request('http://localhost/api/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
      body: 'not-json',
    }),
    supabaseContext(createFakeSupabaseAuth()),
  );
  assert.equal(res.status, 400);
});
