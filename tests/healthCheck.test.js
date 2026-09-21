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
    extraEnv: {
      ALLOWED_ORIGINS: 'https://normisraf.netlify.app,https://raf-app-ten.vercel.app',
    },
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
