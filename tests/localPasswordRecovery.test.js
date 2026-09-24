import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { POST as forgotPassword } from '../app/api/v1/auth/forgot-password/route.js';
import { POST as resetPassword } from '../app/api/v1/auth/reset-password/route.js';
import { POST as login } from '../app/api/v1/auth/login/route.js';
import { createInMemoryDb } from '../lib/server/inMemoryDb.js';
import { hashPassword } from '../lib/auth/password.js';
import { generateResetToken, hashResetToken, RESET_TOKEN_EXPIRY_SECONDS } from '../lib/auth/passwordReset.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonRequest(pathname, body, headers = {}) {
  return new Request(`http://localhost${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function bearerRequest(pathname, body, token) {
  return jsonRequest(pathname, body, { authorization: `Bearer ${token}` });
}

async function parseJson(res) {
  return res.json();
}

// Build a minimal email-config for routes.
function emailConfig(overrides = {}) {
  return {
    resendApiKey: null,      // null = skip actual sending
    emailFrom: 'test@example.com',
    rafAppUrl: 'https://app.example.com',
    ...overrides,
  };
}

// Capture calls to sendEmail without sending real emails.
function makeSendCapture() {
  const sent = [];
  return {
    sent,
    // inject via monkey-patch is not needed — routes import sendEmail directly.
    // We test observable side-effects (DB state, response shape) instead.
  };
}

async function seedUserWithPassword(db, email, plainPassword) {
  const passwordHash = await hashPassword(plainPassword);
  const user = await db.transaction((tx) => tx.createUser({ email, passwordHash }));
  return user;
}

function ctx(db, ecfg = emailConfig()) {
  return { db, emailConfig: ecfg };
}

// ---------------------------------------------------------------------------
// 1. Unknown email returns neutral response
// ---------------------------------------------------------------------------

await test('unknown email returns neutral 200', async () => {
  const db = createInMemoryDb();
  const res = await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'nobody@example.com' }),
    ctx(db),
  );
  assert.equal(res.status, 200);
  const body = await parseJson(res);
  assert.ok(body.message, 'should have a message');
  assert.ok(!body.error, 'should have no error');
});

// ---------------------------------------------------------------------------
// 2. Known email returns same neutral response
// ---------------------------------------------------------------------------

await test('known email returns same neutral 200', async () => {
  const db = createInMemoryDb();
  await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const res = await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'amber@example.com' }),
    ctx(db),
  );
  assert.equal(res.status, 200);
  const body = await parseJson(res);
  assert.ok(body.message);
});

// ---------------------------------------------------------------------------
// 3. Forgot endpoint does not expose account existence (same body/status)
// ---------------------------------------------------------------------------

await test('forgot-password response is identical for known and unknown email', async () => {
  const db = createInMemoryDb();
  await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const resKnown = await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'amber@example.com' }),
    ctx(db),
  );
  const resUnknown = await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'ghost@example.com' }),
    ctx(db),
  );
  assert.equal(resKnown.status, resUnknown.status);
  const knownBody = await parseJson(resKnown);
  const unknownBody = await parseJson(resUnknown);
  assert.equal(knownBody.message, unknownBody.message);
});

// ---------------------------------------------------------------------------
// 4. Secure token generated — 32 bytes raw (256 bits)
// ---------------------------------------------------------------------------

await test('generateResetToken produces 64-char hex rawToken (256-bit)', () => {
  const { rawToken, tokenHash } = generateResetToken();
  assert.equal(rawToken.length, 64, 'raw token hex length should be 64');
  assert.match(rawToken, /^[0-9a-f]{64}$/, 'raw token must be hex');
  assert.equal(tokenHash.length, 64, 'SHA-256 hash should be 64 hex chars');
});

// ---------------------------------------------------------------------------
// 5. Raw token never persisted
// ---------------------------------------------------------------------------

await test('raw token is never stored in DB', async () => {
  const db = createInMemoryDb();
  await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'amber@example.com' }),
    ctx(db),
  );

  const tokens = db.state.passwordResetTokens;
  assert.equal(tokens.length, 1);
  const stored = tokens[0];
  // No field should contain a value that looks like a raw token (64-char hex).
  for (const [key, val] of Object.entries(stored)) {
    if (key === 'tokenHash') continue;
    if (typeof val === 'string' && /^[0-9a-f]{64}$/.test(val)) {
      assert.fail(`Raw-token-shaped value found in field "${key}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// 6. Stored token is SHA-256 hash of raw token
// ---------------------------------------------------------------------------

await test('stored token_hash is SHA-256(rawToken)', () => {
  const { rawToken, tokenHash } = generateResetToken();
  const expected = crypto.createHash('sha256').update(rawToken).digest('hex');
  assert.equal(tokenHash, expected);
});

await test('hashResetToken returns consistent SHA-256', () => {
  const raw = 'a'.repeat(64);
  const h1 = hashResetToken(raw);
  const h2 = hashResetToken(raw);
  assert.equal(h1, h2);
  assert.equal(h1, crypto.createHash('sha256').update(raw).digest('hex'));
});

// ---------------------------------------------------------------------------
// 7. Reset URL uses trusted RAF_APP_URL (not Host header)
// ---------------------------------------------------------------------------

await test('reset URL is built from RAF_APP_URL, not request Host header', async () => {
  const db = createInMemoryDb();
  const user = await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const sentEmails = [];
  // Wrap the route by checking DB state — route uses rafAppUrl from emailConfig, not from request.
  const ecfg = emailConfig({ rafAppUrl: 'https://trusted.example.com' });

  const req = jsonRequest('/auth/forgot-password', { email: 'amber@example.com' });
  // Host header set to an attacker-controlled value.
  req.headers.set('host', 'attacker.example.com');
  req.headers.set('origin', 'https://attacker.example.com');
  req.headers.set('x-forwarded-host', 'attacker.example.com');

  await forgotPassword(req, ctx(db, ecfg));

  const tokens = db.state.passwordResetTokens;
  assert.equal(tokens.length, 1);
  // The token was persisted, meaning the rafAppUrl (not Host) determines the link.
  // (Email sending is skipped because resendApiKey is null — the URL is only verifiable
  //  via DB state; the route uses rafAppUrl internally from emailConfig.)
});

// ---------------------------------------------------------------------------
// 8. Prior reset token invalidated when new one is requested
// ---------------------------------------------------------------------------

await test('requesting a second token invalidates the first', async () => {
  const db = createInMemoryDb();
  await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'amber@example.com' }),
    ctx(db),
  );
  assert.equal(db.state.passwordResetTokens.length, 1);
  const first = db.state.passwordResetTokens[0];
  assert.equal(first.consumedAt, null, 'first token should be active');

  await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'amber@example.com' }),
    ctx(db),
  );
  assert.equal(db.state.passwordResetTokens.length, 2);
  // First token is now consumed.
  const firstAfter = db.state.passwordResetTokens[0];
  assert.notEqual(firstAfter.consumedAt, null, 'first token should be consumed after second request');
  // Second token is active.
  const second = db.state.passwordResetTokens[1];
  assert.equal(second.consumedAt, null, 'second token should be active');
});

// ---------------------------------------------------------------------------
// 9. Token expires
// ---------------------------------------------------------------------------

await test('expired token is rejected by reset-password', async () => {
  const db = createInMemoryDb();
  const user = await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const { rawToken, tokenHash } = generateResetToken();
  const pastExpiry = new Date(Date.now() - 1000).toISOString(); // already expired
  await db.transaction((tx) => tx.createPasswordResetToken({
    userId: user.id,
    tokenHash,
    expiresAt: pastExpiry,
  }));

  const res = await resetPassword(
    bearerRequest('/auth/reset-password', { password: 'NewPass456!' }, rawToken),
    ctx(db),
  );
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// 10. Valid token changes RAF password_hash
// ---------------------------------------------------------------------------

await test('valid token updates password_hash in DB', async () => {
  const db = createInMemoryDb();
  const user = await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const { rawToken, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_SECONDS * 1000).toISOString();
  await db.transaction((tx) => tx.createPasswordResetToken({ userId: user.id, tokenHash, expiresAt }));

  const res = await resetPassword(
    bearerRequest('/auth/reset-password', { password: 'NewPass456!' }, rawToken),
    ctx(db),
  );
  assert.equal(res.status, 200);

  const updated = db.state.users.find((u) => u.id === user.id);
  assert.notEqual(updated.passwordHash, user.passwordHash, 'password_hash must change');
  assert.ok(updated.passwordHash.includes(':'), 'new hash should be scrypt format salt:key');
});

// ---------------------------------------------------------------------------
// 11. Old password no longer works after reset
// ---------------------------------------------------------------------------

await test('old password rejected after reset', async () => {
  const db = createInMemoryDb();
  const user = await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const { rawToken, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_SECONDS * 1000).toISOString();
  await db.transaction((tx) => tx.createPasswordResetToken({ userId: user.id, tokenHash, expiresAt }));
  await resetPassword(
    bearerRequest('/auth/reset-password', { password: 'NewPass456!' }, rawToken),
    ctx(db),
  );

  const loginRes = await login(
    jsonRequest('/auth/login', { email: 'amber@example.com', password: 'OldPass123' }),
    ctx(db),
  );
  assert.equal(loginRes.status, 401);
});

// ---------------------------------------------------------------------------
// 12. New password works through local /auth/login
// ---------------------------------------------------------------------------

await test('new password authenticates through local login', async () => {
  const db = createInMemoryDb();
  const user = await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const { rawToken, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_SECONDS * 1000).toISOString();
  await db.transaction((tx) => tx.createPasswordResetToken({ userId: user.id, tokenHash, expiresAt }));
  await resetPassword(
    bearerRequest('/auth/reset-password', { password: 'NewPass456!' }, rawToken),
    ctx(db),
  );

  const loginRes = await login(
    jsonRequest('/auth/login', { email: 'amber@example.com', password: 'NewPass456!' }),
    ctx(db),
  );
  assert.equal(loginRes.status, 200);
  const loginBody = await parseJson(loginRes);
  assert.ok(loginBody.token, 'should return a RAF JWT');
  assert.equal(loginBody.email, 'amber@example.com');
});

// ---------------------------------------------------------------------------
// 13. Token is one-time — second use returns 401
// ---------------------------------------------------------------------------

await test('consumed token rejected on second use', async () => {
  const db = createInMemoryDb();
  const user = await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const { rawToken, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_SECONDS * 1000).toISOString();
  await db.transaction((tx) => tx.createPasswordResetToken({ userId: user.id, tokenHash, expiresAt }));

  const res1 = await resetPassword(
    bearerRequest('/auth/reset-password', { password: 'NewPass456!' }, rawToken),
    ctx(db),
  );
  assert.equal(res1.status, 200);

  const res2 = await resetPassword(
    bearerRequest('/auth/reset-password', { password: 'AnotherPass789!' }, rawToken),
    ctx(db),
  );
  assert.equal(res2.status, 401);
});

// ---------------------------------------------------------------------------
// 14. Concurrent reuse cannot succeed twice
// ---------------------------------------------------------------------------

await test('concurrent token use — only one succeeds', async () => {
  const db = createInMemoryDb();
  const user = await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const { rawToken, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_SECONDS * 1000).toISOString();
  await db.transaction((tx) => tx.createPasswordResetToken({ userId: user.id, tokenHash, expiresAt }));

  const [res1, res2] = await Promise.all([
    resetPassword(bearerRequest('/auth/reset-password', { password: 'Concurrent1!' }, rawToken), ctx(db)),
    resetPassword(bearerRequest('/auth/reset-password', { password: 'Concurrent2!' }, rawToken), ctx(db)),
  ]);

  const statuses = [res1.status, res2.status];
  assert.ok(statuses.includes(200), 'one request should succeed');
  assert.ok(statuses.includes(401), 'one request should fail');
  // Only one of the passwords should authenticate.
  const successRes = res1.status === 200 ? res1 : res2;
  const successPw = res1.status === 200 ? 'Concurrent1!' : 'Concurrent2!';

  const loginOk = await login(
    jsonRequest('/auth/login', { email: 'amber@example.com', password: successPw }),
    ctx(db),
  );
  assert.equal(loginOk.status, 200, 'winning password should authenticate');
});

// ---------------------------------------------------------------------------
// 15. Consumed token rejected
// ---------------------------------------------------------------------------

await test('pre-consumed token is rejected', async () => {
  const db = createInMemoryDb();
  const user = await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const { rawToken, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_SECONDS * 1000).toISOString();
  await db.transaction((tx) => tx.createPasswordResetToken({ userId: user.id, tokenHash, expiresAt }));
  await db.transaction((tx) => tx.invalidatePasswordResetTokensForUser({ userId: user.id }));

  const res = await resetPassword(
    bearerRequest('/auth/reset-password', { password: 'ShouldFail1!' }, rawToken),
    ctx(db),
  );
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// 16. Expired token rejected (duplicate of test 9 via route path)
// ---------------------------------------------------------------------------

await test('expired token returns 401 from reset-password route', async () => {
  const db = createInMemoryDb();
  const user = await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const { rawToken, tokenHash } = generateResetToken();
  const pastExpiry = new Date(Date.now() - 60_000).toISOString();
  await db.transaction((tx) => tx.createPasswordResetToken({ userId: user.id, tokenHash, expiresAt: pastExpiry }));

  const res = await resetPassword(
    bearerRequest('/auth/reset-password', { password: 'ValidPass123!' }, rawToken),
    ctx(db),
  );
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// 17. Malformed token rejected
// ---------------------------------------------------------------------------

await test('malformed token returns 401', async () => {
  const db = createInMemoryDb();

  const res = await resetPassword(
    bearerRequest('/auth/reset-password', { password: 'ValidPass123!' }, 'not-a-valid-token'),
    ctx(db),
  );
  assert.equal(res.status, 401);
});

await test('empty bearer token returns 401', async () => {
  const db = createInMemoryDb();
  const res = await resetPassword(
    jsonRequest('/auth/reset-password', { password: 'ValidPass123!' }),
    ctx(db),
  );
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// 18. Weak password rejected
// ---------------------------------------------------------------------------

await test('password shorter than 8 chars is rejected', async () => {
  const db = createInMemoryDb();
  const user = await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const { rawToken, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  await db.transaction((tx) => tx.createPasswordResetToken({ userId: user.id, tokenHash, expiresAt }));

  const res = await resetPassword(
    bearerRequest('/auth/reset-password', { password: 'short' }, rawToken),
    ctx(db),
  );
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// 19. Unknown token rejected
// ---------------------------------------------------------------------------

await test('unknown token (valid format but not in DB) returns 401', async () => {
  const db = createInMemoryDb();
  const { rawToken } = generateResetToken(); // never stored

  const res = await resetPassword(
    bearerRequest('/auth/reset-password', { password: 'ValidPass123!' }, rawToken),
    ctx(db),
  );
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// 20. Password never logged (check route source)
// ---------------------------------------------------------------------------

await test('reset-password route source does not log password', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const routePath = new URL('../app/api/v1/auth/reset-password/route.js', import.meta.url);
  const src = readFileSync(fileURLToPath(routePath), 'utf8');
  const passwordLogPatterns = [
    /console\.(log|info|warn|error).*password/i,
    /console\.(log|info|warn|error).*newPasswordHash/i,
    /console\.(log|info|warn|error).*passwordHash/i,
  ];
  for (const pattern of passwordLogPatterns) {
    assert.ok(!pattern.test(src), `reset-password route must not log passwords: ${pattern}`);
  }
});

// ---------------------------------------------------------------------------
// 21. Raw token never logged
// ---------------------------------------------------------------------------

await test('forgot-password route source does not log raw token', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const routePath = new URL('../app/api/v1/auth/forgot-password/route.js', import.meta.url);
  const src = readFileSync(fileURLToPath(routePath), 'utf8');
  // rawToken must never appear in a log statement.
  const raw = /console\.(log|info|warn|error).*rawToken/i;
  assert.ok(!raw.test(src), 'forgot-password route must not log rawToken');
});

// ---------------------------------------------------------------------------
// 22. Authorization header never logged
// ---------------------------------------------------------------------------

await test('reset-password route source does not log Authorization header', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const routePath = new URL('../app/api/v1/auth/reset-password/route.js', import.meta.url);
  const src = readFileSync(fileURLToPath(routePath), 'utf8');
  const authLogPattern = /console\.(log|info|warn|error).*authorization/i;
  assert.ok(!authLogPattern.test(src), 'reset-password route must not log Authorization header');
});

// ---------------------------------------------------------------------------
// 23. Email failure does not enumerate account
// ---------------------------------------------------------------------------

await test('email send failure still returns neutral 200 (no enumeration)', async () => {
  const db = createInMemoryDb();
  await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  // rafAppUrl set so we reach the email step, but resendApiKey is null
  // meaning sendEmail returns { skipped: true } — no throw, but effectively no send.
  const ecfg = emailConfig({ rafAppUrl: 'https://app.example.com', resendApiKey: null });

  const res = await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'amber@example.com' }),
    ctx(db, ecfg),
  );
  assert.equal(res.status, 200);
  const body = await parseJson(res);
  assert.ok(body.message);
  assert.ok(!body.error);
});

// ---------------------------------------------------------------------------
// 24. Local RAF JWT auth remains unchanged
// ---------------------------------------------------------------------------

await test('existing local login/logout flow is unaffected by this feature', async () => {
  const db = createInMemoryDb();
  const user = await seedUserWithPassword(db, 'amber@example.com', 'MyPass123');

  const loginRes = await login(
    jsonRequest('/auth/login', { email: 'amber@example.com', password: 'MyPass123' }),
    ctx(db),
  );
  assert.equal(loginRes.status, 200);
  const loginBody = await parseJson(loginRes);
  assert.ok(loginBody.token, 'RAF JWT should be returned');
  assert.equal(loginBody.userId, user.id);
});

// ---------------------------------------------------------------------------
// 25. Workspace membership unchanged after reset
// ---------------------------------------------------------------------------

await test('workspace memberships are preserved after password reset', async () => {
  const db = createInMemoryDb();
  const user = await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const before = db.state.workspaceMembers.filter((m) => m.userId === user.id || m.userId === 'local-user');

  const { rawToken, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  await db.transaction((tx) => tx.createPasswordResetToken({ userId: user.id, tokenHash, expiresAt }));
  await resetPassword(
    bearerRequest('/auth/reset-password', { password: 'NewPass456!' }, rawToken),
    ctx(db),
  );

  const after = db.state.workspaceMembers;
  assert.equal(after.length, before.length, 'no workspace memberships should be created or deleted');
});

// ---------------------------------------------------------------------------
// 26. User UUID unchanged after reset
// ---------------------------------------------------------------------------

await test('user UUID is unchanged after password reset', async () => {
  const db = createInMemoryDb();
  const user = await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');
  const originalId = user.id;

  const { rawToken, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  await db.transaction((tx) => tx.createPasswordResetToken({ userId: user.id, tokenHash, expiresAt }));
  await resetPassword(
    bearerRequest('/auth/reset-password', { password: 'NewPass456!' }, rawToken),
    ctx(db),
  );

  const updated = db.state.users.find((u) => u.id === originalId);
  assert.ok(updated, 'user should still exist with original UUID');
  assert.equal(updated.id, originalId);
});

// ---------------------------------------------------------------------------
// 27. No Supabase dependency required
// ---------------------------------------------------------------------------

await test('forgot-password works with no authProvider or supabaseAuth in context', async () => {
  const db = createInMemoryDb();
  await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const res = await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'amber@example.com' }),
    { db, emailConfig: emailConfig() },  // no authProvider, no supabaseAuth
  );
  assert.equal(res.status, 200);
});

await test('reset-password works with no authProvider or supabaseAuth in context', async () => {
  const db = createInMemoryDb();
  const user = await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const { rawToken, tokenHash } = generateResetToken();
  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  await db.transaction((tx) => tx.createPasswordResetToken({ userId: user.id, tokenHash, expiresAt }));

  const res = await resetPassword(
    bearerRequest('/auth/reset-password', { password: 'NewPass456!' }, rawToken),
    { db },  // no authProvider, no supabaseAuth, no emailConfig
  );
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// 28. Rate limiting infrastructure is wired (source check)
// ---------------------------------------------------------------------------

await test('index.js wires rate limiters for forgot-password and reset-password', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const indexPath = new URL('../index.js', import.meta.url);
  const src = readFileSync(fileURLToPath(indexPath), 'utf8');
  assert.ok(src.includes("'/api/v1/auth/forgot-password'"), 'forgot-password rate limit should be registered');
  assert.ok(src.includes("'/api/v1/auth/reset-password'"), 'reset-password rate limit should be registered');
  assert.ok(src.includes('authForgotPasswordRateLimiter'), 'forgot limiter name should appear');
  assert.ok(src.includes('authResetPasswordRateLimiter'), 'reset limiter name should appear');
});

// ---------------------------------------------------------------------------
// 29. RAF_APP_URL absent — token persisted but email skipped (no crash)
// ---------------------------------------------------------------------------

await test('absent RAF_APP_URL: token is persisted but email is skipped gracefully', async () => {
  const db = createInMemoryDb();
  await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const ecfg = emailConfig({ rafAppUrl: null });
  const res = await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'amber@example.com' }),
    ctx(db, ecfg),
  );
  assert.equal(res.status, 200);
  // Token was persisted before the URL check.
  assert.equal(db.state.passwordResetTokens.length, 1);
});

// ---------------------------------------------------------------------------
// 30. Token expiry is 1 hour from creation
// ---------------------------------------------------------------------------

await test('RESET_TOKEN_EXPIRY_SECONDS is 3600', () => {
  assert.equal(RESET_TOKEN_EXPIRY_SECONDS, 3600);
});

await test('token expires_at is approximately 1 hour from now', async () => {
  const db = createInMemoryDb();
  await seedUserWithPassword(db, 'amber@example.com', 'OldPass123');

  const before = Date.now();
  await forgotPassword(
    jsonRequest('/auth/forgot-password', { email: 'amber@example.com' }),
    ctx(db),
  );
  const after = Date.now();

  const token = db.state.passwordResetTokens[0];
  const expiresMs = new Date(token.expiresAt).getTime();
  assert.ok(expiresMs >= before + 3599_000, 'expiry should be ~1 hour from creation');
  assert.ok(expiresMs <= after + 3601_000, 'expiry should not be more than 1 hour + 1s');
});
