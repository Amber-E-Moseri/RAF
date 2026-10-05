/**
 * Auth rate limiting behind a reverse proxy (Render).
 *
 * In-process Express apps only — no database, no spawned server — so these are
 * fast and not sensitive to machine load.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createAuthRateLimiters, parseTrustProxy } from '../lib/server/rateLimit.js';

async function startApp({ trustProxy, ipMax = 100, accountMax = 3 }) {
  const app = express();
  app.set('trust proxy', trustProxy);
  const limiters = createAuthRateLimiters({ ipMax, accountMax });
  app.use(express.json());
  app.use('/login', ...limiters.login);
  app.use('/signup', ...limiters.signup);
  app.post('/login', (req, res) => {
    res.status(req.body?.password === 'good' ? 200 : 401).json({});
  });
  app.post('/signup', (_req, res) => res.status(201).json({}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function post(base, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return res.status;
}

test('proxy-derived client IP: different clients behind one proxy get separate IP buckets', async () => {
  const app = await startApp({ trustProxy: 1, ipMax: 3, accountMax: 1000 });
  try {
    // The proxy appends the real client address as the right-most X-Forwarded-For entry.
    const a = { 'x-forwarded-for': '203.0.113.10' };
    const b = { 'x-forwarded-for': '203.0.113.20' };
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push(await post(app.base, '/login', { email: `u${i}@x.test`, password: 'bad' }, a));
    assert.deepEqual(statuses, [401, 401, 401, 429, 429], 'client A is limited by its own IP');
    assert.equal(await post(app.base, '/login', { email: 'other@x.test', password: 'bad' }, b), 401, 'client B is unaffected');
  } finally { await app.stop(); }
});

test('spoofed X-Forwarded-For prefixes cannot bypass the IP limit when one proxy hop is trusted', async () => {
  const app = await startApp({ trustProxy: 1, ipMax: 3, accountMax: 1000 });
  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      // Attacker rotates a fake left-most entry; the trusted proxy's right-most entry is fixed.
      statuses.push(await post(app.base, '/login', { email: `u${i}@x.test`, password: 'bad' },
        { 'x-forwarded-for': `10.0.0.${i}, 198.51.100.7` }));
    }
    assert.equal(statuses.filter((s) => s === 429).length, 3);
  } finally { await app.stop(); }
});

test('without trust proxy, X-Forwarded-For is ignored entirely', async () => {
  const app = await startApp({ trustProxy: false, ipMax: 3, accountMax: 1000 });
  try {
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(await post(app.base, '/login', { email: `u${i}@x.test`, password: 'bad' },
        { 'x-forwarded-for': `10.0.0.${i}` }));
    }
    assert.equal(statuses.filter((s) => s === 429).length, 3);
  } finally { await app.stop(); }
});

test('separate accounts behind the same IP do not exhaust one shared account bucket', async () => {
  const app = await startApp({ trustProxy: false, ipMax: 1000, accountMax: 3 });
  try {
    for (let i = 0; i < 3; i++) assert.equal(await post(app.base, '/login', { email: 'victim@x.test', password: 'bad' }), 401);
    assert.equal(await post(app.base, '/login', { email: 'victim@x.test', password: 'bad' }), 429);
    assert.equal(await post(app.base, '/login', { email: 'someone-else@x.test', password: 'good' }), 200);
    assert.equal(await post(app.base, '/login', { email: 'third@x.test', password: 'bad' }), 401);
  } finally { await app.stop(); }
});

test('repeated failures against one account are limited even when the attacker rotates IPs', async () => {
  const app = await startApp({ trustProxy: 1, ipMax: 1000, accountMax: 3 });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push(await post(app.base, '/login', { email: 'Target@X.test ', password: 'bad' },
        { 'x-forwarded-for': `192.0.2.${i + 1}` }));
    }
    assert.deepEqual(statuses, [401, 401, 401, 429, 429], 'email is normalised (case/whitespace) and IP rotation does not help');
  } finally { await app.stop(); }
});

test('successful logins never consume the per-account failure budget', async () => {
  const app = await startApp({ trustProxy: false, ipMax: 1000, accountMax: 3 });
  try {
    for (let i = 0; i < 10; i++) assert.equal(await post(app.base, '/login', { email: 'me@x.test', password: 'good' }), 200);
    assert.equal(await post(app.base, '/login', { email: 'me@x.test', password: 'bad' }), 401);
  } finally { await app.stop(); }
});

test('requests without an email fall back to IP-only limiting', async () => {
  const app = await startApp({ trustProxy: false, ipMax: 2, accountMax: 3 });
  try {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push(await post(app.base, '/login', { password: 'bad' }));
    assert.deepEqual(statuses, [401, 401, 429, 429]);
  } finally { await app.stop(); }
});

test('signup is limited per account as well as per IP', async () => {
  const app = await startApp({ trustProxy: false, ipMax: 1000, accountMax: 3 });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push(await post(app.base, '/signup', { email: 'dup@x.test' }));
    assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
    assert.equal(await post(app.base, '/signup', { email: 'new@x.test' }), 201);
  } finally { await app.stop(); }
});

test('parseTrustProxy: hop counts only, production defaults to one hop, "true" is rejected', () => {
  assert.equal(parseTrustProxy(undefined, 'production'), 1);
  assert.equal(parseTrustProxy('', 'development'), false);
  assert.equal(parseTrustProxy('false', 'production'), false);
  assert.equal(parseTrustProxy('2', 'production'), 2);
  assert.throws(() => parseTrustProxy('true', 'production'), /not allowed/);
  assert.throws(() => parseTrustProxy('0.0.0.0/0', 'production'));
});
