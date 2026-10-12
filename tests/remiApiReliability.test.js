/**
 * Remi API reliability: throttling, daily cap, Anthropic failure mapping, Zod validation,
 * atomic persistence, and regression for free-tier / non-member behaviour.
 *
 * The router is the REAL createApiRouter (JWT auth, membership, entitlement). The Anthropic
 * API is a local fake HTTP server reached through ANTHROPIC_BASE_URL, so the real SDK's
 * timeout, retry and error classes are exercised. No request ever leaves 127.0.0.1.
 * Remi storage is an in-memory double with transactional rollback, mirroring Postgres.
 */

import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

process.env.JWT_SECRET = 'remi-api-reliability-test-secret';
process.env.RAF_AUTH_REQUIRED = 'true';

const { createApiRouter } = await import('../lib/server/routerLoader.js');
const { createInMemoryDb } = await import('../lib/server/inMemoryDb.js');
const { ensureUserOnboarded } = await import('../lib/auth/onboarding.js');
const { createToken } = await import('../lib/auth/jwt.js');
const { loadRemiConfig } = await import('../lib/server/env.js');
const { createKeyedWindowLimiter } = await import('../lib/server/rateLimit.js');
const { POST: chatRoutePost } = await import('../app/api/v1/remi/chat/route.js');
const { REMI_UNAVAILABLE_MESSAGE, REMI_SAVE_FAILED_MESSAGE, REMI_BUSY_MESSAGE, REMI_DAILY_LIMIT_MESSAGE } = await import('../lib/remi/remiGuards.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_KEY = 'sk-ant-SERVER-SENTINEL-do-not-leak-0123456789';
const UPSTREAM_SECRET = 'UPSTREAM_SECRET_TEXT_must_not_reach_client';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REMI_ENV_KEYS = [
  'REMI_USER_RATE_LIMIT_PER_MINUTE',
  'REMI_WORKSPACE_RATE_LIMIT_PER_MINUTE',
  'REMI_DAILY_MESSAGE_LIMIT',
  'REMI_ANTHROPIC_TIMEOUT_MS',
  'REMI_ANTHROPIC_MAX_RETRIES',
];

// ── Fake Anthropic upstream ───────────────────────────────────────────────────

let fake;
let fakeSockets = new Set();
let fakeCalls = [];
let upstreamMode = 'ok';
let previousBaseUrl;

function okBody() {
  return {
    id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake',
    content: [{ type: 'text', text: 'FAKE_AI_REPLY' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  };
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

before(async () => {
  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      fakeCalls.push({ apiKey: req.headers['x-api-key'], url: req.url, body });
      const errorBody = (type) => ({ type: 'error', error: { type, message: UPSTREAM_SECRET } });
      switch (upstreamMode) {
        case 'ok': return sendJson(res, 200, okBody());
        case 'status500': return sendJson(res, 500, errorBody('api_error'));
        case 'status429': return sendJson(res, 429, errorBody('rate_limit_error'));
        case 'status400': return sendJson(res, 400, errorBody('invalid_request_error'));
        case 'hang': return undefined; // never answers: the SDK timeout must fire
        case 'destroy': return req.socket.destroy(); // network-level failure
        default: return sendJson(res, 500, errorBody('api_error'));
      }
    });
  });
  fake.on('connection', (socket) => {
    fakeSockets.add(socket);
    socket.on('close', () => fakeSockets.delete(socket));
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  previousBaseUrl = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fake.address().port}`;
});

after(async () => {
  if (previousBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = previousBaseUrl;
  for (const key of REMI_ENV_KEYS) delete process.env[key];
  for (const socket of fakeSockets) socket.destroy();
  await new Promise((resolve) => fake.close(resolve));
});

// Defaults are deliberately generous; individual tests tighten the limit they exercise.
function setRemiEnv(overrides = {}) {
  const values = {
    REMI_USER_RATE_LIMIT_PER_MINUTE: 50,
    REMI_WORKSPACE_RATE_LIMIT_PER_MINUTE: 500,
    REMI_DAILY_MESSAGE_LIMIT: 1000,
    REMI_ANTHROPIC_TIMEOUT_MS: 1000,
    REMI_ANTHROPIC_MAX_RETRIES: 0,
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) process.env[key] = String(value);
}

beforeEach(() => {
  setRemiEnv();
  fakeCalls = [];
  upstreamMode = 'ok';
});

// ── Harness ───────────────────────────────────────────────────────────────────

async function captureLogs(fn) {
  const lines = [];
  const orig = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    orig[m] = console[m];
    console[m] = (...args) => { lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  }
  try {
    return { result: await fn(), logs: lines.join('\n') };
  } finally {
    for (const m of Object.keys(orig)) console[m] = orig[m];
  }
}

// Builds the real router with an in-memory DB. `store` holds Remi rows; transactions roll
// back on throw, like Postgres does.
async function startApp({ anthropicApiKey = SERVER_KEY, tier = 'paid' } = {}) {
  const db = createInMemoryDb();
  const owner = { id: crypto.randomUUID(), email: `owner-${crypto.randomUUID()}@example.test` };
  const { workspaces } = await ensureUserOnboarded({ db, user: owner, workspaceName: 'Remi Reliability WS' });
  const workspaceId = workspaces[0].workspaceId ?? workspaces[0].id;
  db.state.households.find((h) => h.id === workspaceId).remiTier = tier;

  const store = { conversations: [], messages: [], failAppendRole: null };

  const remiStorage = {
    async createRemiConversation({ householdId, userId, title }) {
      const row = { id: crypto.randomUUID(), householdId, userId, title, createdAt: new Date().toISOString() };
      store.conversations.push(row);
      return { ...row };
    },
    async getRemiConversation({ householdId, conversationId, userId }) {
      const row = store.conversations.find((c) => c.id === conversationId && c.householdId === householdId && c.userId === userId);
      return row ? { ...row } : null;
    },
    async listRemiMessages({ householdId, conversationId, userId }) {
      const owned = store.conversations.some((c) => c.id === conversationId && c.householdId === householdId && c.userId === userId);
      if (!owned) return [];
      return store.messages.filter((m) => m.conversationId === conversationId && m.householdId === householdId).map((m) => ({ ...m }));
    },
    async appendRemiMessage({ householdId, conversationId, userId, role, content, tokensUsed }) {
      if (store.failAppendRole === role) throw new Error('simulated database failure');
      const row = {
        id: crypto.randomUUID(), householdId, conversationId, userId, role, content, tokensUsed,
        createdAt: new Date().toISOString(),
      };
      store.messages.push(row);
      return { ...row };
    },
    async countRemiUserMessagesSince({ householdId, since }) {
      return store.messages.filter((m) => m.householdId === householdId && m.role === 'user' && m.createdAt >= since).length;
    },
    async listRemiConversations() { return []; },
  };

  const realTransaction = db.transaction.bind(db);
  db.transaction = (callback, securityContext) => realTransaction(async (tx) => {
    const snapshot = { conversations: [...store.conversations], messages: [...store.messages] };
    try {
      return await callback(Object.assign(tx, remiStorage));
    } catch (error) {
      store.conversations = snapshot.conversations;
      store.messages = snapshot.messages;
      throw error;
    }
  }, securityContext);

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
  // Mirrors index.js: the global handler forwards error.status and error.message only.
  app.use((err, _req, res, _next) => res.status(err.status ?? 500).json({ error: err.message }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  const tokenFor = (userId, email) => createToken({ userId, email });
  const ownerToken = tokenFor(owner.id, owner.email);

  // Adds an active workspace member (not the owner) and returns their token.
  const addMember = () => {
    const member = { id: crypto.randomUUID(), email: `member-${crypto.randomUUID()}@example.test` };
    db.state.workspaceMembers.push({
      id: crypto.randomUUID(), workspaceId, userId: member.id, role: 'member', status: 'active', joinedAt: new Date().toISOString(),
    });
    return tokenFor(member.id, member.email);
  };

  const call = (route, { method = 'GET', body, rawBody, query = '', token = ownerToken, headers = {} } = {}) => {
    const init = {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-workspace-id': workspaceId, 'content-type': 'application/json', ...headers },
    };
    if (rawBody !== undefined) init.body = rawBody;
    else if (body !== undefined && method !== 'GET') init.body = JSON.stringify(body);
    return fetch(`${base}${route}${query}`, init).then(async (r) => ({
      status: r.status,
      headers: r.headers,
      text: await r.text(),
    }));
  };

  return {
    db, store, workspaceId, owner, ownerToken, addMember, tokenFor, call,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

const chat = (app, opts = {}) => app.call('/remi/chat', { method: 'POST', body: { message: 'How am I doing?' }, ...opts });
const summary = (app, opts = {}) => app.call('/remi/summary', opts);
const parse = (text) => JSON.parse(text);
const GENERIC_UNAVAILABLE = { error: REMI_UNAVAILABLE_MESSAGE, errorCode: 'REMI_UNAVAILABLE' };

// ── Throttling ────────────────────────────────────────────────────────────────

test('throttle: per-user limit returns 429 with Retry-After and the other member keeps working until the workspace bucket is full', async () => {
  setRemiEnv({ REMI_USER_RATE_LIMIT_PER_MINUTE: 3, REMI_WORKSPACE_RATE_LIMIT_PER_MINUTE: 5 });
  const app = await startApp();
  try {
    for (let i = 0; i < 3; i++) {
      const ok = await chat(app, { body: { message: `q${i}` } });
      assert.equal(ok.status, 200, ok.text);
    }
    const limited = await chat(app);
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('retry-after'), /^\d+$/);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal(parse(limited.text).error, REMI_BUSY_MESSAGE);
    assert.equal(fakeCalls.length, 3, 'the throttled request never reached Anthropic');

    // Design: a per-user denial does not consume workspace budget, so another member is served.
    const memberToken = app.addMember();
    const memberFirst = await chat(app, { token: memberToken });
    assert.equal(memberFirst.status, 200, memberFirst.text);
    const memberSecond = await chat(app, { token: memberToken });
    assert.equal(memberSecond.status, 200, memberSecond.text);
    // The workspace bucket (5/min) is now full, so the next member request is denied.
    const memberThird = await chat(app, { token: memberToken });
    assert.equal(memberThird.status, 429);
    assert.ok(memberThird.headers.get('retry-after'));
  } finally { await app.stop(); }
});

test('throttle: summary shares the paid per-user budget with chat', async () => {
  setRemiEnv({ REMI_USER_RATE_LIMIT_PER_MINUTE: 1 });
  const app = await startApp();
  try {
    assert.equal((await summary(app)).status, 200);
    const second = await chat(app);
    assert.equal(second.status, 429);
    assert.equal(fakeCalls.length, 1);
  } finally { await app.stop(); }
});

// ── Daily cap ─────────────────────────────────────────────────────────────────

test('daily cap: 429 once the workspace has reached its 24h user-message limit, with no new rows', async () => {
  setRemiEnv({ REMI_DAILY_MESSAGE_LIMIT: 2 });
  const app = await startApp();
  try {
    const first = await chat(app, { body: { message: 'one' } });
    assert.equal(first.status, 200, first.text);
    const second = await chat(app, { body: { message: 'two', conversationId: parse(first.text).conversationId } });
    assert.equal(second.status, 200, second.text);

    const capped = await chat(app, { body: { message: 'three', conversationId: parse(first.text).conversationId } });
    assert.equal(capped.status, 429);
    assert.equal(capped.headers.get('retry-after'), '3600');
    assert.equal(parse(capped.text).error, REMI_DAILY_LIMIT_MESSAGE);
    assert.equal(fakeCalls.length, 2);
    assert.equal(app.store.messages.length, 4, 'no rows written for the capped request');
  } finally { await app.stop(); }
});

test('daily cap: counts only user messages from the last 24 hours', async () => {
  setRemiEnv({ REMI_DAILY_MESSAGE_LIMIT: 1 });
  const app = await startApp();
  try {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const recent = new Date(Date.now() - 60 * 1000).toISOString();
    app.store.messages.push(
      { id: 'old', householdId: app.workspaceId, conversationId: 'x', userId: 'x', role: 'user', content: 'old', tokensUsed: 0, createdAt: old },
      { id: 'asst', householdId: app.workspaceId, conversationId: 'x', userId: 'x', role: 'assistant', content: 'a', tokensUsed: 0, createdAt: recent },
    );
    const res = await chat(app);
    assert.equal(res.status, 200, res.text);
  } finally { await app.stop(); }
});

// ── Anthropic failure mapping ─────────────────────────────────────────────────

const FAILURE_MODES = [
  { mode: 'status500', expected: 503 },
  { mode: 'status429', expected: 429 },
  { mode: 'status400', expected: 503 },
  { mode: 'hang', expected: 503 },
  { mode: 'destroy', expected: 503 },
];

for (const { mode, expected } of FAILURE_MODES) {
  test(`anthropic ${mode}: chat returns a generic ${expected} body, leaks nothing, and creates no conversation`, async () => {
    upstreamMode = mode;
    const app = await startApp();
    try {
      const { result, logs } = await captureLogs(() => chat(app));
      assert.equal(result.status, expected, result.text);
      assert.deepEqual(parse(result.text), GENERIC_UNAVAILABLE);
      if (expected === 429) assert.equal(result.headers.get('retry-after'), '30');
      assert.ok(!result.text.includes(UPSTREAM_SECRET), 'upstream text not in body');
      assert.ok(!result.text.includes(SERVER_KEY), 'key not in body');
      assert.ok(!logs.includes(UPSTREAM_SECRET), 'upstream text not logged');
      assert.ok(!logs.includes(SERVER_KEY), 'key not logged');
      const event = logs.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((e) => e?.event === 'remi_model_failure');
      assert.ok(event, 'structured failure event logged');
      assert.equal(event.route, 'chat');
      assert.equal(app.store.conversations.length, 0, 'no conversation row created');
      assert.equal(app.store.messages.length, 0, 'no message row created');
    } finally { await app.stop(); }
  });
}

test('anthropic 500: summary returns the same generic body and no upstream text', async () => {
  upstreamMode = 'status500';
  const app = await startApp();
  try {
    const res = await summary(app);
    assert.equal(res.status, 503);
    assert.deepEqual(parse(res.text), GENERIC_UNAVAILABLE);
    assert.ok(!res.text.includes(UPSTREAM_SECRET));
  } finally { await app.stop(); }
});

test('anthropic 429: summary maps to 429 with Retry-After and the generic body', async () => {
  upstreamMode = 'status429';
  const app = await startApp();
  try {
    const res = await summary(app);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '30');
    assert.deepEqual(parse(res.text), GENERIC_UNAVAILABLE);
  } finally { await app.stop(); }
});

test('anthropic failure on an existing conversation writes nothing to it', async () => {
  const app = await startApp();
  try {
    const first = await chat(app, { body: { message: 'first question' } });
    assert.equal(first.status, 200, first.text);
    const { conversationId } = parse(first.text);
    assert.equal(app.store.messages.length, 2);

    upstreamMode = 'status500';
    const failed = await chat(app, { body: { message: 'second question', conversationId } });
    assert.equal(failed.status, 503);
    assert.equal(app.store.messages.length, 2, 'no partial user message saved');
    assert.equal(app.store.conversations.length, 1);
  } finally { await app.stop(); }
});

// ── Zod validation ────────────────────────────────────────────────────────────

const INVALID_CHAT_BODIES = [
  ['missing message', {}],
  ['whitespace-only message', { message: '   ' }],
  ['non-string message', { message: 123 }],
  ['oversize message (4001 chars)', { message: 'a'.repeat(4001) }],
  ['non-UUID conversationId', { message: 'hi', conversationId: 'conv_1' }],
];

for (const [label, body] of INVALID_CHAT_BODIES) {
  test(`chat validation: ${label} -> 400 generic, Anthropic never called`, async () => {
    const app = await startApp();
    try {
      const res = await chat(app, { body });
      assert.equal(res.status, 400, res.text);
      assert.deepEqual(parse(res.text), { error: 'Invalid request.', errorCode: 'VALIDATION_ERROR' });
      assert.ok(!res.text.includes('ZodError') && !res.text.includes('at '), 'no internals in body');
      assert.equal(fakeCalls.length, 0);
    } finally { await app.stop(); }
  });
}

test('chat validation: a message of exactly 4000 characters is accepted', async () => {
  const app = await startApp();
  try {
    const res = await chat(app, { body: { message: 'a'.repeat(4000) } });
    assert.equal(res.status, 200, res.text);
  } finally { await app.stop(); }
});

test('chat validation: malformed JSON through the real stack -> 400 without a stack trace', async () => {
  const app = await startApp();
  try {
    const res = await app.call('/remi/chat', { method: 'POST', rawBody: '{"message": "hi",' });
    assert.equal(res.status, 400);
    assert.ok(!res.text.includes('\n    at '), 'no stack frames');
    assert.equal(fakeCalls.length, 0);
  } finally { await app.stop(); }
});

test('chat route: malformed JSON handed directly to the handler -> 400 generic body', async () => {
  const request = new Request('http://localhost/api/v1/remi/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  const res = await chatRoutePost(request, { db: null, householdId: 'h1', workspaceId: 'h1', userId: 'u1', anthropicApiKey: SERVER_KEY });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'Invalid request.', errorCode: 'VALIDATION_ERROR' });
});

const INVALID_MONTHS = ['2026-13', '2026-00', '2026-1', 'March 2026', '26-03', ''];
for (const month of INVALID_MONTHS) {
  test(`summary validation: month "${month}" -> 400`, async () => {
    const app = await startApp();
    try {
      const res = await summary(app, { query: `?month=${encodeURIComponent(month)}` });
      assert.equal(res.status, 400, res.text);
      assert.deepEqual(parse(res.text), { error: 'Invalid request.', errorCode: 'VALIDATION_ERROR' });
      assert.equal(fakeCalls.length, 0);
    } finally { await app.stop(); }
  });
}

test('summary validation: a valid month is accepted and reflected', async () => {
  const app = await startApp({ tier: 'free' });
  try {
    const res = await summary(app, { query: '?month=2026-01' });
    assert.equal(res.status, 200, res.text);
    assert.equal(parse(res.text).month, '2026-01');
  } finally { await app.stop(); }
});

// ── Regression: free tier and non-members ─────────────────────────────────────

test('free tier: chat keeps the knowledge-base reply and is never throttled or persisted', async () => {
  setRemiEnv({ REMI_USER_RATE_LIMIT_PER_MINUTE: 1, REMI_DAILY_MESSAGE_LIMIT: 1 });
  const app = await startApp({ tier: 'free' });
  try {
    for (let i = 0; i < 4; i++) {
      const res = await chat(app, { body: { message: `free ${i}` } });
      assert.equal(res.status, 200, res.text);
      assert.equal(parse(res.text).tier, 'free');
    }
    assert.equal(fakeCalls.length, 0);
    assert.equal(app.store.conversations.length, 0);
  } finally { await app.stop(); }
});

test('free tier: summary keeps the snapshot response', async () => {
  const app = await startApp({ tier: 'free' });
  try {
    const res = await summary(app);
    assert.equal(res.status, 200);
    assert.equal(parse(res.text).tier, 'free');
    assert.equal(fakeCalls.length, 0);
  } finally { await app.stop(); }
});

test('non-member: chat and summary return 403 before any limiter or validation logic runs', async () => {
  setRemiEnv({ REMI_USER_RATE_LIMIT_PER_MINUTE: 1 });
  const app = await startApp();
  try {
    const outsider = app.tokenFor(crypto.randomUUID(), 'outsider@example.test');
    for (let i = 0; i < 5; i++) {
      const res = await chat(app, { token: outsider, body: { message: 'hi' } });
      assert.equal(res.status, 403);
    }
    const outsiderSummary = await summary(app, { token: outsider });
    assert.equal(outsiderSummary.status, 403);

    // Rejected outsider traffic must not consume the paid member's budget.
    const member = await chat(app);
    assert.equal(member.status, 200, member.text);
    assert.equal(fakeCalls.length, 1);
  } finally { await app.stop(); }
});

// ── Paid success path and persistence ─────────────────────────────────────────

test('paid success: chat creates a conversation with both messages, and a follow-up appends to it with history', async () => {
  const app = await startApp();
  try {
    const first = await chat(app, { body: { message: '  first question  ' } });
    assert.equal(first.status, 200, first.text);
    const body = parse(first.text);
    assert.equal(body.reply, 'FAKE_AI_REPLY');
    assert.equal(body.tier, 'paid');
    assert.match(body.conversationId, UUID_RE);
    assert.equal(app.store.conversations.length, 1);
    assert.deepEqual(app.store.messages.map((m) => [m.role, m.content]), [
      ['user', 'first question'],
      ['assistant', 'FAKE_AI_REPLY'],
    ]);
    assert.ok(fakeCalls.every((c) => c.apiKey === SERVER_KEY), 'server key used upstream');

    const followUp = await chat(app, { body: { message: 'second question', conversationId: body.conversationId } });
    assert.equal(followUp.status, 200, followUp.text);
    assert.equal(parse(followUp.text).conversationId, body.conversationId);
    assert.equal(app.store.conversations.length, 1, 'no second conversation');
    assert.equal(app.store.messages.length, 4);
    assert.ok(fakeCalls.at(-1).body.includes('first question'), 'prior turns sent as history');
  } finally { await app.stop(); }
});

test('paid success: summary returns the AI text with the paid tier', async () => {
  const app = await startApp();
  try {
    const res = await summary(app, { query: '?month=2026-03' });
    assert.equal(res.status, 200, res.text);
    const body = parse(res.text);
    assert.equal(body.tier, 'paid');
    assert.equal(body.summary, 'FAKE_AI_REPLY');
    assert.equal(body.month, '2026-03');
  } finally { await app.stop(); }
});

test('paid: another member cannot append to or read a conversation they do not own', async () => {
  const app = await startApp();
  try {
    const first = await chat(app, { body: { message: 'private' } });
    const { conversationId } = parse(first.text);
    const intruder = app.addMember();

    const attempt = await chat(app, { token: intruder, body: { message: 'injected', conversationId } });
    assert.equal(attempt.status, 404);
    assert.deepEqual(parse(attempt.text), { error: 'Conversation not found.', errorCode: 'NOT_FOUND' });
    assert.equal(app.store.messages.length, 2, 'nothing written to the owner conversation');
    assert.equal(app.store.conversations.length, 1);
  } finally { await app.stop(); }
});

test('persistence failure: a failed assistant write rolls back the user message and conversation, with a generic body', async () => {
  const app = await startApp();
  try {
    app.store.failAppendRole = 'assistant';
    const { result, logs } = await captureLogs(() => chat(app));
    assert.equal(result.status, 500);
    assert.deepEqual(parse(result.text), { error: REMI_SAVE_FAILED_MESSAGE, errorCode: 'ERROR' });
    assert.ok(!result.text.includes('simulated database failure'));
    assert.ok(logs.includes('remi_persist_failure'));
    assert.equal(app.store.conversations.length, 0, 'conversation rolled back');
    assert.equal(app.store.messages.length, 0, 'user message rolled back');
    assert.equal(fakeCalls.length, 1);
  } finally { await app.stop(); }
});

// ── Config and limiter units ──────────────────────────────────────────────────

test('config: safe defaults when unset, and invalid values fall back instead of failing', () => {
  assert.deepEqual(loadRemiConfig({}), {
    userPerMinute: 10,
    workspacePerMinute: 30,
    dailyMessageLimit: 200,
    anthropicTimeoutMs: 30000,
    anthropicMaxRetries: 1,
  });
  const parsed = loadRemiConfig({
    REMI_USER_RATE_LIMIT_PER_MINUTE: 'abc',
    REMI_ANTHROPIC_TIMEOUT_MS: '999999999',
    REMI_ANTHROPIC_MAX_RETRIES: '2',
    REMI_DAILY_MESSAGE_LIMIT: '0',
  });
  assert.equal(parsed.userPerMinute, 10);
  assert.equal(parsed.anthropicTimeoutMs, 30000);
  assert.equal(parsed.anthropicMaxRetries, 2);
  assert.equal(parsed.dailyMessageLimit, 200);
});

test('keyed limiter: denies beyond max, isolates keys, and resets after the window', () => {
  const limiter = createKeyedWindowLimiter({ windowMs: 60000 });
  const t0 = 1_000_000;
  assert.equal(limiter.consume('a', { max: 2, now: t0 }).allowed, true);
  assert.equal(limiter.consume('a', { max: 2, now: t0 }).allowed, true);
  const denied = limiter.consume('a', { max: 2, now: t0 + 1000 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSeconds, 59);
  assert.equal(limiter.consume('b', { max: 2, now: t0 }).allowed, true);
  assert.equal(limiter.consume('a', { max: 2, now: t0 + 60000 }).allowed, true, 'window reset');
});
