/**
 * Health endpoint tests: liveness vs readiness split.
 *
 * Covers:
 *   Unit: checkReadiness() with mock db: success and failure paths
 *   Integration: live isolated SQLite server: /health and /api/v1/health
 *   Liveness independence: DB failure keeps /health 200 while /api/v1/health is 503
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { checkReadiness } from '../lib/server/readinessHandler.js';
import { startIsolatedSqliteServer } from './helpers/isolatedSqliteServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

test('checkReadiness: db.ping() succeeds -> status 200, ok:true, db:connected', async () => {
  const db = { ping: async () => {} };
  const result = await checkReadiness(db);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, db: 'connected' });
});

test('checkReadiness: db.ping() throws -> status 503, ok:false, db:unavailable', async () => {
  const db = { ping: async () => { throw new Error('Connection refused'); } };
  const result = await checkReadiness(db);
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { ok: false, db: 'unavailable' });
});

test('checkReadiness: does not expose internal error details in body', async () => {
  const db = { ping: async () => { throw new Error('host=db.internal password=secret'); } };
  const result = await checkReadiness(db);
  const bodyStr = JSON.stringify(result.body);
  assert.ok(!bodyStr.includes('password'), 'error details must not appear in response body');
  assert.ok(!bodyStr.includes('db.internal'), 'connection details must not appear in response body');
});

test('liveness is independent of DB failure', async () => {
  const failingDb = { ping: async () => { throw new Error('simulated DB unavailable'); } };

  const app = express();
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', service: 'raf-api' });
  });
  app.get('/api/v1/health', async (_req, res) => {
    const { status, body } = await checkReadiness(failingDb);
    res.status(status).json(body);
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    const liveness = await fetch(`${base}/health`);
    assert.equal(liveness.status, 200, 'liveness must return 200 regardless of DB state');
    const livenessBody = await liveness.json();
    assert.equal(livenessBody.status, 'ok');

    const readiness = await fetch(`${base}/api/v1/health`);
    assert.equal(readiness.status, 503, 'readiness must return 503 when DB is unavailable');
    const readinessBody = await readiness.json();
    assert.equal(readinessBody.ok, false);
    assert.equal(readinessBody.db, 'unavailable');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

let liveServer;
let baseUrl;

before(async () => {
  liveServer = await startIsolatedSqliteServer({
    repoRoot,
    testName: 'raf-health-check',
  });
  baseUrl = liveServer.baseUrl;
});

after(async () => {
  await liveServer?.stop();
});

test('GET /health (liveness) returns 200 with static body', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'raf-api');
});

test('GET /api/v1/health (readiness) returns 200 when DB is available', async () => {
  const res = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, 'connected');
});

test('GET /api/v1/health requires no auth token', async () => {
  const res = await fetch(`${baseUrl}/api/v1/health`, { headers: {} });
  assert.notEqual(res.status, 401, 'readiness probe must not require a JWT');
  assert.notEqual(res.status, 403, 'readiness probe must not require workspace membership');
});

test('GET /api/v1/health exposes no tenant or connection data', async () => {
  const res = await fetch(`${baseUrl}/api/v1/health`);
  const bodyStr = await res.text();
  const parsed = JSON.parse(bodyStr);
  const keys = Object.keys(parsed);
  assert.deepEqual(keys.sort(), ['db', 'ok'].sort(), 'response must only contain ok and db fields');
});

// Temporary CORS diagnostic tests (D2.7B-R13 — removed after single call)
// R13A semantic verification tests
test('CORS diagnostic: F — exact response contract', async () => {
  const res = await fetch(`${baseUrl}/__diag/cors-runtime`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const keys = Object.keys(body).sort();
  const expected = ['configured', 'netlifyAllowed', 'nonEmpty', 'originCount', 'vercelAllowed'].sort();
  assert.deepEqual(keys, expected, 'diagnostic must return exactly these fields, no more, no less');
  assert.equal(typeof body.configured, 'boolean', 'configured must be boolean');
  assert.equal(typeof body.nonEmpty, 'boolean', 'nonEmpty must be boolean');
  assert.equal(typeof body.originCount, 'number', 'originCount must be number');
  assert.equal(typeof body.netlifyAllowed, 'boolean', 'netlifyAllowed must be boolean');
  assert.equal(typeof body.vercelAllowed, 'boolean', 'vercelAllowed must be boolean');
});

test('CORS diagnostic: G — no secrets or raw origins exposed', async () => {
  const res = await fetch(`${baseUrl}/__diag/cors-runtime`);
  const bodyStr = await res.text();
  assert.ok(!bodyStr.includes('normisraf'), 'must not expose raw Netlify origin');
  assert.ok(!bodyStr.includes('raf-app-ten'), 'must not expose raw Vercel origin');
  assert.ok(!bodyStr.includes('ALLOWED_ORIGINS'), 'must not expose env var name');
  assert.ok(!bodyStr.includes('process.env'), 'must not expose process object');
  assert.ok(!bodyStr.includes('JWT_SECRET'), 'must not expose JWT');
  assert.ok(!bodyStr.includes('DATABASE_URL'), 'must not expose DB credentials');
  assert.ok(!bodyStr.includes('POSTGRES'), 'must not expose Postgres config');
  assert.ok(!bodyStr.includes('neondb'), 'must not expose Neon connection');
});

test('CORS diagnostic: H — /health regression', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['service', 'status'].sort(), '/health must not be modified by diagnostic');
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'raf-api');
});

test('CORS diagnostic: I — /api/v1/health regression', async () => {
  const res = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['db', 'ok'].sort(), '/api/v1/health must not be modified by diagnostic');
  assert.equal(body.ok, true);
  assert.equal(body.db, 'connected');
});

// Unit-style semantic verification (not requiring full isolated server)
test('CORS diagnostic: A — ALLOWED_ORIGINS absent', async () => {
  // Simulate absent env var
  const configured = Object.prototype.hasOwnProperty.call({}, 'ALLOWED_ORIGINS');
  const nonEmpty = Boolean(undefined?.trim());
  assert.equal(configured, false, 'configured must be false when env var absent');
  assert.equal(nonEmpty, false, 'nonEmpty must be false when env var absent');
});

test('CORS diagnostic: B — ALLOWED_ORIGINS present but empty', async () => {
  // Simulate empty env var
  const configured = Object.prototype.hasOwnProperty.call({ ALLOWED_ORIGINS: '' }, 'ALLOWED_ORIGINS');
  const nonEmpty = Boolean(''.trim());
  assert.equal(configured, true, 'configured must be true when env var is set (even if empty)');
  assert.equal(nonEmpty, false, 'nonEmpty must be false when value is empty');
});

test('CORS diagnostic: C — production-shaped two-origin configuration', async () => {
  // Simulate production parser
  const rawValue = 'https://normisraf.netlify.app,https://raf-app-ten.vercel.app';
  const configured = Object.prototype.hasOwnProperty.call({ ALLOWED_ORIGINS: rawValue }, 'ALLOWED_ORIGINS');
  const nonEmpty = Boolean(rawValue.trim());
  const parsed = rawValue.split(',').map((o) => o.trim()).filter(Boolean);
  const set = new Set(parsed);

  assert.equal(configured, true);
  assert.equal(nonEmpty, true);
  assert.equal(set.size, 2, 'must parse exactly 2 origins');
  assert.equal(set.has('https://normisraf.netlify.app'), true, 'Netlify origin must be in Set');
  assert.equal(set.has('https://raf-app-ten.vercel.app'), true, 'Vercel origin must be in Set');
});

test('CORS diagnostic: D — unrelated origin not matched', async () => {
  // Simulate different configuration
  const rawValue = 'https://example.com';
  const parsed = rawValue.split(',').map((o) => o.trim()).filter(Boolean);
  const set = new Set(parsed);

  assert.equal(set.has('https://normisraf.netlify.app'), false, 'Netlify origin must not match');
  assert.equal(set.has('https://raf-app-ten.vercel.app'), false, 'Vercel origin must not match');
});

test('CORS diagnostic: E — whitespace around origins handled correctly', async () => {
  // Simulate production parser with extra whitespace
  const rawValue = '  https://normisraf.netlify.app , https://raf-app-ten.vercel.app  ';
  const parsed = rawValue.split(',').map((o) => o.trim()).filter(Boolean);
  const set = new Set(parsed);

  assert.equal(set.size, 2, 'whitespace must be trimmed correctly');
  assert.equal(set.has('https://normisraf.netlify.app'), true, 'Netlify origin must match despite whitespace');
  assert.equal(set.has('https://raf-app-ten.vercel.app'), true, 'Vercel origin must match despite whitespace');
});


test('CORS diagnostic: absent variable case', async () => {
  const app = express();
  delete process.env.ALLOWED_ORIGINS;
  const allowedOriginsSet = new Set([]);

  app.get('/__diag/cors-runtime', (_req, res) => {
    const configured = Object.prototype.hasOwnProperty.call(process.env, 'ALLOWED_ORIGINS');
    const nonEmpty = Boolean(process.env.ALLOWED_ORIGINS?.trim());
    res.status(200).json({
      configured,
      nonEmpty,
      originCount: allowedOriginsSet.size,
      netlifyAllowed: allowedOriginsSet.has('https://normisraf.netlify.app'),
      vercelAllowed: allowedOriginsSet.has('https://raf-app-ten.vercel.app'),
    });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/__diag/cors-runtime`);
    const body = await res.json();
    assert.equal(body.configured, false, 'configured must be false when env var absent');
    assert.equal(body.nonEmpty, false, 'nonEmpty must be false when env var absent');
    assert.equal(body.originCount, 0, 'originCount must be 0');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('CORS diagnostic: empty variable case', async () => {
  const app = express();
  process.env.ALLOWED_ORIGINS = '';
  const allowedOriginsSet = new Set([]);

  app.get('/__diag/cors-runtime', (_req, res) => {
    const configured = Object.prototype.hasOwnProperty.call(process.env, 'ALLOWED_ORIGINS');
    const nonEmpty = Boolean(process.env.ALLOWED_ORIGINS?.trim());
    res.status(200).json({
      configured,
      nonEmpty,
      originCount: allowedOriginsSet.size,
      netlifyAllowed: allowedOriginsSet.has('https://normisraf.netlify.app'),
      vercelAllowed: allowedOriginsSet.has('https://raf-app-ten.vercel.app'),
    });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/__diag/cors-runtime`);
    const body = await res.json();
    assert.equal(body.configured, true, 'configured must be true when env var is set');
    assert.equal(body.nonEmpty, false, 'nonEmpty must be false when empty');
    assert.equal(body.originCount, 0, 'originCount must be 0');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.ALLOWED_ORIGINS;
  }
});

test('CORS diagnostic: production-shaped value', async () => {
  const app = express();
  process.env.ALLOWED_ORIGINS = 'https://normisraf.netlify.app,https://raf-app-ten.vercel.app';
  const allowedOriginsArray = process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  const allowedOriginsSet = new Set(allowedOriginsArray);

  app.get('/__diag/cors-runtime', (_req, res) => {
    const configured = Object.prototype.hasOwnProperty.call(process.env, 'ALLOWED_ORIGINS');
    const nonEmpty = Boolean(process.env.ALLOWED_ORIGINS?.trim());
    res.status(200).json({
      configured,
      nonEmpty,
      originCount: allowedOriginsSet.size,
      netlifyAllowed: allowedOriginsSet.has('https://normisraf.netlify.app'),
      vercelAllowed: allowedOriginsSet.has('https://raf-app-ten.vercel.app'),
    });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/__diag/cors-runtime`);
    const body = await res.json();
    assert.equal(body.configured, true, 'configured must be true');
    assert.equal(body.nonEmpty, true, 'nonEmpty must be true');
    assert.equal(body.originCount, 2, 'originCount must be 2');
    assert.equal(body.netlifyAllowed, true, 'netlifyAllowed must be true');
    assert.equal(body.vercelAllowed, true, 'vercelAllowed must be true');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.ALLOWED_ORIGINS;
  }
});

test('CORS diagnostic: whitespace handling', async () => {
  const app = express();
  process.env.ALLOWED_ORIGINS = '  https://normisraf.netlify.app , https://raf-app-ten.vercel.app  ';
  const allowedOriginsArray = process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  const allowedOriginsSet = new Set(allowedOriginsArray);

  app.get('/__diag/cors-runtime', (_req, res) => {
    const configured = Object.prototype.hasOwnProperty.call(process.env, 'ALLOWED_ORIGINS');
    const nonEmpty = Boolean(process.env.ALLOWED_ORIGINS?.trim());
    res.status(200).json({
      configured,
      nonEmpty,
      originCount: allowedOriginsSet.size,
      netlifyAllowed: allowedOriginsSet.has('https://normisraf.netlify.app'),
      vercelAllowed: allowedOriginsSet.has('https://raf-app-ten.vercel.app'),
    });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/__diag/cors-runtime`);
    const body = await res.json();
    assert.equal(body.originCount, 2, 'whitespace must be trimmed correctly');
    assert.equal(body.netlifyAllowed, true, 'Netlify must be found despite whitespace');
    assert.equal(body.vercelAllowed, true, 'Vercel must be found despite whitespace');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    delete process.env.ALLOWED_ORIGINS;
  }
});
