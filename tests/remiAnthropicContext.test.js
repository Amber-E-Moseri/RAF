/**
 * Paid Remi AI wiring: ANTHROPIC_API_KEY -> trusted request context -> Remi routes.
 *
 * These tests build the context through the REAL createApiRouter / resolveTrustedContext
 * (JWT auth, workspace membership, entitlement) and never inject `anthropicApiKey` into a
 * route directly. The Anthropic API is replaced by a local fake HTTP server (via
 * ANTHROPIC_BASE_URL), so no real request is ever made.
 *
 * Documented behaviour when the server key is missing: a PAID workspace falls back to the
 * free knowledge-base reply (chat) / plain snapshot (summary), tier "free", HTTP 200.
 */

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

process.env.JWT_SECRET = 'remi-anthropic-context-test-secret';
process.env.RAF_AUTH_REQUIRED = 'true';

const { createApiRouter } = await import('../lib/server/routerLoader.js');
const { createInMemoryDb } = await import('../lib/server/inMemoryDb.js');
const { ensureUserOnboarded } = await import('../lib/auth/onboarding.js');
const { createToken } = await import('../lib/auth/jwt.js');
const { loadServerEnv } = await import('../lib/server/env.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_KEY = 'sk-ant-SERVER-SENTINEL-do-not-leak-0123456789';
const CLIENT_KEY = 'sk-ant-CLIENT-SUPPLIED-must-be-ignored';

let fake;
let fakeCalls = [];
let previousBaseUrl;

before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      fakeCalls.push({ apiKey: req.headers['x-api-key'], url: req.url, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake',
        content: [{ type: 'text', text: 'FAKE_AI_REPLY' }],
        stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 2 },
      }));
    });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
});

after(async () => {
  if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
  await new Promise((resolve) => fake.close(resolve));
});

// Builds a real router exactly like index.js does, with the given server key.
async function startApp({ anthropicApiKey, tier }) {
  const db = createInMemoryDb();
  const user = { id: crypto.randomUUID(), email: `u-${crypto.randomUUID()}@example.test` };
  const { workspaces } = await ensureUserOnboarded({ db, user, workspaceName: 'Remi WS' });
  const workspaceId = workspaces[0].workspaceId ?? workspaces[0].id;
  const row = db.state.households.find((h) => h.id === workspaceId);
  row.remiTier = tier;

  // The in-memory adapter has no Remi conversation storage (Postgres does). Stub ONLY those
  // storage methods; auth, membership, entitlement and context construction stay real.
  const remiStorage = {
    async createRemiConversation() { return { id: crypto.randomUUID() }; },
    async getRemiConversation() { return null; },
    async listRemiMessages() { return []; },
    async appendRemiMessage() {},
    async listRemiConversations() { return []; },
  };
  const realTransaction = db.transaction.bind(db);
  db.transaction = (callback, securityContext) => realTransaction((tx) => callback(Object.assign(tx, remiStorage)), securityContext);

  const app = express();
  app.use(express.json());
  app.use('/api/v1', await createApiRouter({
    apiRootDir: path.join(repoRoot, 'app', 'api', 'v1'),
    db,
    defaultHouseholdId: null,
    aliases: [],
    emailConfig: null,
    anthropicApiKey,
  }));
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const token = createToken({ userId: user.id, email: user.email });
  const call = (route, { method = 'GET', body, query = '', headers = {} } = {}) => fetch(`${base}${route}${query}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId, 'content-type': 'application/json', ...headers },
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, text: await r.text() }));
  return { call, stop: () => new Promise((resolve) => server.close(resolve)) };
}

// Captures everything the app writes to the console while `fn` runs.
async function captureLogs(fn) {
  const lines = [];
  const orig = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    orig[m] = console[m];
    console[m] = (...args) => { lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  }
  try { return { result: await fn(), logs: lines.join('\n') }; } finally {
    for (const m of Object.keys(orig)) console[m] = orig[m];
  }
}

const chat = (app, extra = {}) => app.call('/remi/chat', { ...extra, method: 'POST', body: { message: 'How am I doing?', ...extra.body } });
const summary = (app, extra = {}) => app.call('/remi/summary', extra);

for (const [name, run, paidReplyCheck] of [
  ['chat', chat, (t) => JSON.parse(t).reply === 'FAKE_AI_REPLY'],
  ['summary', summary, (t) => JSON.parse(t).summary === 'FAKE_AI_REPLY'],
]) {
  test(`${name}: free workspace + server key never invokes Anthropic`, async () => {
    fakeCalls = [];
    const app = await startApp({ anthropicApiKey: SERVER_KEY, tier: 'free' });
    try {
      const { result, logs } = await captureLogs(() => run(app));
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(result.text).tier, 'free');
      assert.equal(fakeCalls.length, 0);
      assert.ok(!result.text.includes(SERVER_KEY) && !logs.includes(SERVER_KEY));
    } finally { await app.stop(); }
  });

  test(`${name}: paid workspace + server key reaches the paid AI path with the server key`, async () => {
    fakeCalls = [];
    const app = await startApp({ anthropicApiKey: SERVER_KEY, tier: 'paid' });
    try {
      const { result, logs } = await captureLogs(() => run(app));
      assert.equal(result.status, 200, result.text);
      assert.equal(JSON.parse(result.text).tier, 'paid');
      assert.ok(paidReplyCheck(result.text), 'response carries the (fake) AI output');
      assert.equal(fakeCalls.length >= 1, true);
      assert.ok(fakeCalls.every((c) => c.apiKey === SERVER_KEY), 'server key used for upstream call');
      assert.ok(!result.text.includes(SERVER_KEY), 'key not in response body');
      assert.ok(!logs.includes(SERVER_KEY), 'key not in application logs');
    } finally { await app.stop(); }
  });

  test(`${name}: paid workspace without a server key falls back safely to the free path`, async () => {
    fakeCalls = [];
    const app = await startApp({ anthropicApiKey: null, tier: 'paid' });
    try {
      const { result } = await captureLogs(() => run(app));
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(result.text).tier, 'free');
      assert.equal(fakeCalls.length, 0);
    } finally { await app.stop(); }
  });

  test(`${name}: client-supplied anthropicApiKey (header/body/query) has no effect`, async () => {
    const inject = {
      headers: { 'x-anthropic-api-key': CLIENT_KEY, 'anthropic-api-key': CLIENT_KEY, 'x-api-key': CLIENT_KEY },
      query: `?anthropicApiKey=${CLIENT_KEY}`,
      body: { anthropicApiKey: CLIENT_KEY },
    };
    // 1. paid + no server key: the client key must not enable the AI path
    fakeCalls = [];
    let app = await startApp({ anthropicApiKey: null, tier: 'paid' });
    try {
      const r = await run(app, inject);
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(r.text).tier, 'free');
      assert.equal(fakeCalls.length, 0);
    } finally { await app.stop(); }
    // 2. paid + server key: the client key must not replace the server key
    fakeCalls = [];
    app = await startApp({ anthropicApiKey: SERVER_KEY, tier: 'paid' });
    try {
      const r = await run(app, inject);
      assert.equal(r.status, 200, r.text);
      assert.ok(fakeCalls.length >= 1);
      assert.ok(fakeCalls.every((c) => c.apiKey === SERVER_KEY), 'upstream always uses the server key');
    } finally { await app.stop(); }
    // 3. free + client key: still no AI
    fakeCalls = [];
    app = await startApp({ anthropicApiKey: SERVER_KEY, tier: 'free' });
    try {
      const r = await run(app, inject);
      assert.equal(JSON.parse(r.text).tier, 'free');
      assert.equal(fakeCalls.length, 0);
    } finally { await app.stop(); }
  });
}

test('startup config: ANTHROPIC_API_KEY is read from the environment, optional, and trimmed', () => {
  const prev = { ...process.env };
  try {
    process.env.PERSISTENCE_DRIVER = 'sqlite';
    process.env.RAF_DB_PATH = ':memory:';
    process.env.RAF_AUTH_REQUIRED = 'false';
    process.env.ANTHROPIC_API_KEY = `  ${SERVER_KEY}  `;
    assert.equal(loadServerEnv({ cwd: path.join(repoRoot, 'tests', 'fixtures') }).anthropicApiKey, SERVER_KEY);
    process.env.ANTHROPIC_API_KEY = '';
    assert.equal(loadServerEnv({ cwd: path.join(repoRoot, 'tests', 'fixtures') }).anthropicApiKey, null);
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(loadServerEnv({ cwd: path.join(repoRoot, 'tests', 'fixtures') }).anthropicApiKey, null, 'app boots without the key');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});
